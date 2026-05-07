#!/usr/bin/env node
/**
 * Playwright E2E MCP Server
 *
 * Provides MCP tools for interacting with the Playwright E2E test
 * infrastructure: launching UI mode for demos, running tests headlessly,
 * seeding/cleaning test data, and checking coverage status.
 *
 * @see specs/global/G028-playwright-e2e-testing.md
 * @version 1.0.0
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as crypto from 'crypto';
import { spawn, execFile, execFileSync, execSync } from 'child_process';
import { promisify } from 'util';
const execFileAsync = promisify(execFile);
import Database from 'better-sqlite3';
import { McpServer, type AnyToolHandler } from '../shared/server.js';
import { loadServicesConfig, resolveLocalSecrets, resolveOpReferencesStrict, opRead, INFRA_CRED_KEYS, buildCleanEnv } from '../shared/op-secrets.js';
import {
  LaunchUiModeArgsSchema,
  RunTestsArgsSchema,
  SeedDataArgsSchema,
  CleanupDataArgsSchema,
  GetReportArgsSchema,
  GetCoverageStatusArgsSchema,
  PreflightCheckArgsSchema,
  ListExtensionTabsArgsSchema,
  ScreenshotExtensionTabArgsSchema,
  OpenVideoArgsSchema,
  type OpenVideoArgs,
  type OpenVideoResult,
  type LaunchUiModeArgs,
  type RunTestsArgs,
  type GetReportArgs,
  type PreflightCheckArgs,
  type LaunchUiModeResult,
  type RunTestsResult,
  type SeedDataResult,
  type CleanupDataResult,
  type GetReportResult,
  type GetCoverageStatusResult,
  type CoverageEntry,
  type PreflightCheckEntry,
  type PreflightCheckResult,
  type ListExtensionTabsArgs,
  type ScreenshotExtensionTabArgs,
  type ListExtensionTabsResult,
  type ScreenshotExtensionTabResult,
  type ExtensionTab,
  RunAuthSetupArgsSchema,
  type RunAuthSetupArgs,
  type RunAuthSetupResult,
  RunDemoArgsSchema,
  type RunDemoArgs,
  type RunDemoResult,
  CheckDemoResultArgsSchema,
  StopDemoArgsSchema,
  type CheckDemoResultArgs,
  type StopDemoArgs,
  type CheckDemoResultResult,
  type StopDemoResult,
  type DemoRunState,
  type DemoRunStatus,
  type DemoProgress,
  RunDemoBatchArgsSchema,
  CheckDemoBatchResultArgsSchema,
  StopDemoBatchArgsSchema,
  type RunDemoBatchArgs,
  type CheckDemoBatchResultArgs,
  type StopDemoBatchArgs,
  type CheckDemoBatchResultResult,
  type StopDemoBatchResult,
  type DemoBatchState,
  type BatchScenarioResult,
  type FailureClassificationResult,
  RunPrerequisitesArgsSchema,
  type RunPrerequisitesArgs,
  type PrerequisiteExecEntry,
  type RunPrerequisitesResult,
  GetDemoScreenshotArgsSchema,
  type GetDemoScreenshotArgs,
  type GetDemoScreenshotResult,
  ExtractVideoFramesArgsSchema,
  type ExtractVideoFramesArgs,
  type ExtractVideoFramesResult,
  AcquireDisplayLockArgsSchema,
  ReleaseDisplayLockArgsSchema,
  RenewDisplayLockArgsSchema,
  GetDisplayQueueStatusArgsSchema,
  type AcquireDisplayLockArgs,
  GetFlyStatusArgsSchema,
  type GetFlyStatusArgs,
  DeployFlyImageArgsSchema,
  type DeployFlyImageArgs,
  DeployProjectImageArgsSchema,
  type DeployProjectImageArgs,
  SetFlyMachineRamArgsSchema,
  type SetFlyMachineRamArgs,
  GetFlyMachineRamArgsSchema,
  type GetFlyMachineRamArgs,
  GetFlyLogsArgsSchema,
  type GetFlyLogsArgs,
  SteelHealthCheckArgsSchema,
  type SteelHealthCheckArgs,
  UploadSteelExtensionArgsSchema,
  type UploadSteelExtensionArgs,
} from './types.js';
import { parseTestOutput, truncateOutput, validateExtraEnv } from './helpers.js';
import { discoverPlaywrightConfig } from './config-discovery.js';
import { findTraceZip, parseTraceZip } from './trace-parser.js';
import * as machinePool from './machine-pool.js';

// ============================================================================
// Configuration
// ============================================================================

const PROJECT_DIR = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const WORKTREE_DIR = process.env.CLAUDE_WORKTREE_DIR || null;
/** Where source code + builds live: worktree if set, otherwise main tree */
const EFFECTIVE_CWD = WORKTREE_DIR ? path.resolve(WORKTREE_DIR) : PROJECT_DIR;
const pwConfig = discoverPlaywrightConfig(EFFECTIVE_CWD);
const REPORT_DIR = path.join(PROJECT_DIR, 'playwright-report');

// ============================================================================
// Fly.io Configuration Helper
// ============================================================================

interface FlyConfig {
  enabled: boolean;
  appName: string;
  apiToken: string;
  region?: string;
  machineSize?: string;
  machineRam?: number;
  maxConcurrentMachines?: number;
  projectImageEnabled?: boolean;
}

/** Simple string hash for generating synthetic PIDs for remote demo runs. */
function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash;
}

/**
 * Read the `fly` section from services.json.
 * Returns null if the file is missing, malformed, or has no `fly` section.
 */
function getFlyConfigFromServices(): FlyConfig | null {
  try {
    const servicesPath = path.join(PROJECT_DIR, '.claude', 'config', 'services.json');
    if (!fs.existsSync(servicesPath)) return null;
    const raw = fs.readFileSync(servicesPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('fly' in parsed) ||
      typeof (parsed as Record<string, unknown>)['fly'] !== 'object' ||
      (parsed as Record<string, unknown>)['fly'] === null
    ) {
      return null;
    }
    const fly = (parsed as Record<string, unknown>)['fly'] as Record<string, unknown>;
    if (typeof fly['appName'] !== 'string' || typeof fly['apiToken'] !== 'string') return null;
    return {
      enabled: fly['enabled'] !== false,
      appName: fly['appName'],
      apiToken: fly['apiToken'],
      region: typeof fly['region'] === 'string' ? fly['region'] : undefined,
      machineSize: typeof fly['machineSize'] === 'string' ? fly['machineSize'] : undefined,
      machineRam: typeof fly['machineRam'] === 'number' ? fly['machineRam'] : undefined,
      maxConcurrentMachines: typeof fly['maxConcurrentMachines'] === 'number' ? fly['maxConcurrentMachines'] : undefined,
      projectImageEnabled: fly['projectImageEnabled'] === true,
    };
  } catch {
    return null;
  }
}

/**
 * Read the `steel` section from services.json.
 * Returns null if the file is missing, malformed, or has no `steel` section.
 */
interface SteelServicesConfig {
  enabled: boolean;
  apiKey: string;
  orgId?: string;
  defaultTimeout?: number;
  extensionId?: string;
  proxyConfig?: { enabled: boolean; country?: string };
  maxConcurrentSessions?: number;
}

function getSteelConfigFromServices(): SteelServicesConfig | null {
  try {
    const servicesPath = path.join(PROJECT_DIR, '.claude', 'config', 'services.json');
    if (!fs.existsSync(servicesPath)) return null;
    const raw = fs.readFileSync(servicesPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('steel' in parsed) ||
      typeof (parsed as Record<string, unknown>)['steel'] !== 'object' ||
      (parsed as Record<string, unknown>)['steel'] === null
    ) {
      return null;
    }
    const steel = (parsed as Record<string, unknown>)['steel'] as Record<string, unknown>;
    if (typeof steel['apiKey'] !== 'string') return null;
    return {
      enabled: steel['enabled'] !== false,
      apiKey: steel['apiKey'],
      orgId: typeof steel['orgId'] === 'string' ? steel['orgId'] : undefined,
      defaultTimeout: typeof steel['defaultTimeout'] === 'number' ? steel['defaultTimeout'] : undefined,
      extensionId: typeof steel['extensionId'] === 'string' ? steel['extensionId'] : undefined,
      proxyConfig: typeof steel['proxyConfig'] === 'object' && steel['proxyConfig'] !== null
        ? steel['proxyConfig'] as { enabled: boolean; country?: string }
        : undefined,
      maxConcurrentSessions: typeof steel['maxConcurrentSessions'] === 'number' ? steel['maxConcurrentSessions'] : undefined,
    };
  } catch {
    return null;
  }
}

// ============================================================================
// Profile-Scoped Secret Resolution for run_demo
// ============================================================================

interface ProfileScopedResult {
  /** Successfully resolved secrets (key→value) */
  resolved: Record<string, string>;
  /** Keys that failed to resolve but were skipped (non-fatal) */
  skippedKeys: string[];
  /** Warning messages for skipped keys */
  warnings: string[];
}

/**
 * Resolve secrets.local entries scoped to the current scenario's profile.
 *
 * Instead of resolving ALL secrets.local (which blocks all demos if any
 * single op:// reference is broken), this function:
 * 1. Checks if any secretProfile matches the scenario (via scenarioTags or stealth_required)
 * 2. If matched: resolves ONLY the keys in that profile
 * 3. If no match: resolves all keys individually, skipping failures with warnings
 *
 * This prevents unrelated broken secrets from blocking demos that don't need them.
 */
function resolveProfileScopedSecrets(
  scenarioId: string | undefined,
  stealthRequired: boolean,
): ProfileScopedResult {
  const result: ProfileScopedResult = { resolved: {}, skippedKeys: [], warnings: [] };

  try {
    const servicesPath = path.join(PROJECT_DIR, '.claude', 'config', 'services.json');
    if (!fs.existsSync(servicesPath)) return result;
    const services = JSON.parse(fs.readFileSync(servicesPath, 'utf-8'));
    const allLocalSecrets = services.secrets?.local as Record<string, string> | undefined;
    if (!allLocalSecrets || Object.keys(allLocalSecrets).length === 0) return result;

    const profiles = services.secretProfiles as Record<string, { secretKeys: string[]; match?: { scenarioTags?: string[] } }> | undefined;

    // Determine which keys to resolve based on profile matching
    let keysToResolve: string[] | null = null; // null = resolve all (fallback)

    if (profiles) {
      // Check for profiles that match this scenario via stealth_required flag
      if (stealthRequired) {
        // Look for profiles tagged with stealth scenarios (e.g., "steel-aws", "steel-claude")
        for (const [, profile] of Object.entries(profiles)) {
          if (profile.match?.scenarioTags?.includes('stealth_required')) {
            keysToResolve = keysToResolve || [];
            keysToResolve.push(...profile.secretKeys);
          }
        }
      }

      // If still no match, look for profiles that match the scenario's test_file
      // via existing commandPattern (repurposed for demo file matching)
      if (!keysToResolve && scenarioId) {
        try {
          const feedbackDbPath = getUserFeedbackDbPath();
          if (fs.existsSync(feedbackDbPath)) {
            const feedbackDb = new Database(feedbackDbPath, { readonly: true });
            try {
              const row = feedbackDb.prepare('SELECT test_file FROM demo_scenarios WHERE id = ?')
                .get(scenarioId) as { test_file: string } | undefined;
              if (row?.test_file) {
                for (const [, profile] of Object.entries(profiles)) {
                  const pattern = (profile.match as Record<string, unknown> | undefined)?.commandPattern as string | undefined;
                  if (pattern) {
                    try {
                      if (new RegExp(pattern).test(row.test_file)) {
                        keysToResolve = keysToResolve || [];
                        keysToResolve.push(...profile.secretKeys);
                      }
                    } catch { /* invalid regex — skip */ }
                  }
                }
              }
            } catch { /* non-fatal */ }
            feedbackDb.close();
          }
        } catch { /* non-fatal */ }
      }
    }

    // Infrastructure keys that must ALWAYS be resolved regardless of profile.
    // These are needed for every remote demo (git auth, GitHub API access).
    const INFRA_KEYS = ['GITHUB_TOKEN', 'GH_TOKEN', 'GIT_AUTH_TOKEN'];

    // Resolve the determined set of keys, always including infrastructure keys
    const profileKeys = keysToResolve
      ? [...new Set(keysToResolve)].filter(k => k in allLocalSecrets)
      : Object.keys(allLocalSecrets);
    const infraKeys = INFRA_KEYS.filter(k => k in allLocalSecrets && !profileKeys.includes(k));
    const targetKeys = [...profileKeys, ...infraKeys];

    // Resolve individually so one failure doesn't block the rest
    for (const key of targetKeys) {
      const ref = allLocalSecrets[key];
      if (!ref) continue;
      try {
        const { resolved: single, failedKeys } = resolveOpReferencesStrict({ [key]: ref });
        if (failedKeys.length === 0) {
          result.resolved[key] = single[key];
        } else {
          result.skippedKeys.push(key);
          result.warnings.push(`${key}: failed to resolve (non-fatal, skipped)`);
        }
      } catch {
        result.skippedKeys.push(key);
        result.warnings.push(`${key}: resolution threw (non-fatal, skipped)`);
      }
    }

    // Also include demoDevModeEnv if available
    if (services.demoDevModeEnv) {
      Object.assign(result.resolved, services.demoDevModeEnv);
    }
  } catch { /* non-fatal — return whatever we resolved */ }

  return result;
}

// ============================================================================
// Per-Mode Fly.io Machine RAM Configuration
// ============================================================================

interface FlyMachineRamConfig {
  machineRamHeadless: number; // MB, default 2048
  machineRamHeaded: number;   // MB, default 4096
}

const FLY_MACHINE_CONFIG_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'fly-machine-config.json');
const FLY_RAM_DEFAULTS: FlyMachineRamConfig = { machineRamHeadless: 2048, machineRamHeaded: 4096 };

function readFlyMachineConfig(): FlyMachineRamConfig {
  try {
    if (fs.existsSync(FLY_MACHINE_CONFIG_PATH)) {
      const data = JSON.parse(fs.readFileSync(FLY_MACHINE_CONFIG_PATH, 'utf-8'));
      return {
        machineRamHeadless: typeof data.machineRamHeadless === 'number' ? data.machineRamHeadless : FLY_RAM_DEFAULTS.machineRamHeadless,
        machineRamHeaded: typeof data.machineRamHeaded === 'number' ? data.machineRamHeaded : FLY_RAM_DEFAULTS.machineRamHeaded,
      };
    }
  } catch { /* non-fatal */ }
  return { ...FLY_RAM_DEFAULTS };
}

function writeFlyMachineConfig(config: FlyMachineRamConfig): void {
  fs.mkdirSync(path.dirname(FLY_MACHINE_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(FLY_MACHINE_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

/**
 * Resolve user-feedback.db path — falls back to main tree when running in a worktree.
 * The DB is global shared state (gitignored), so it only exists in the main tree.
 */
function getUserFeedbackDbPath(): string {
  const primary = path.join(PROJECT_DIR, '.claude', 'user-feedback.db');
  if (fs.existsSync(primary)) return primary;

  // Worktree fallback: derive main tree from worktree path
  if (WORKTREE_DIR) {
    const worktreeIdx = PROJECT_DIR.indexOf('/.claude/worktrees/');
    if (worktreeIdx !== -1) {
      const mainTree = PROJECT_DIR.substring(0, worktreeIdx);
      const fallback = path.join(mainTree, '.claude', 'user-feedback.db');
      if (fs.existsSync(fallback)) return fallback;
    }
  }

  return primary;
}

/** Path to the display-lock shared module (hooks/lib/display-lock.js). */
const DISPLAY_LOCK_PATH = path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'display-lock.js');
const RUN_TIMEOUT = 300_000; // 5 minutes for test runs

// ============================================================================
// Worktree Freshness Gate
// ============================================================================

/**
 * Detect the base branch (preview if it exists, otherwise main).
 */
function detectBaseBranch(): string {
  try {
    execFileSync('git', ['rev-parse', '--verify', 'origin/preview'], {
      cwd: PROJECT_DIR, encoding: 'utf8', timeout: 5000, stdio: 'pipe',
    });
    return 'preview';
  } catch {
    return 'main';
  }
}

/**
 * Check if a worktree is behind the base branch and auto-sync if possible.
 * Returns { fresh: true } if up to date (or successfully merged).
 * Returns { fresh: false, message } if stale and cannot auto-merge.
 */
function checkAndSyncWorktree(): { fresh: boolean; message?: string } {
  if (!WORKTREE_DIR) return { fresh: true };

  const baseBranch = detectBaseBranch();
  let behindBy = 0;
  try {
    // Ensure we have latest refs (fast, shared .git means this helps all worktrees)
    execFileSync('git', ['fetch', 'origin', baseBranch, '--quiet'], {
      cwd: PROJECT_DIR, encoding: 'utf8', timeout: 15000, stdio: 'pipe',
    });
  } catch {
    // Fetch failed (offline, timeout) — check with existing refs
  }

  try {
    const countStr = execFileSync(
      'git', ['rev-list', `HEAD..origin/${baseBranch}`, '--count'],
      { cwd: EFFECTIVE_CWD, encoding: 'utf8', timeout: 5000, stdio: 'pipe' },
    ).trim();
    behindBy = parseInt(countStr, 10) || 0;
  } catch {
    // Can't determine freshness — allow through (fail-open)
    return { fresh: true };
  }

  if (behindBy === 0) return { fresh: true };

  // Worktree is behind — check if we can auto-merge
  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: EFFECTIVE_CWD, encoding: 'utf8', timeout: 5000, stdio: 'pipe',
    }).trim();

    if (status.length > 0) {
      return {
        fresh: false,
        message: `Worktree is ${behindBy} commit(s) behind origin/${baseBranch} with uncommitted changes. Commit your changes first, then run: git merge origin/${baseBranch} --no-edit`,
      };
    }

    // Clean working tree — auto-merge
    execFileSync('git', ['merge', `origin/${baseBranch}`, '--no-edit'], {
      cwd: EFFECTIVE_CWD, encoding: 'utf8', timeout: 30000, stdio: 'pipe',
    });
    process.stderr.write(`[playwright] Auto-synced worktree: merged ${behindBy} commit(s) from origin/${baseBranch}\n`);
    // Re-install deps if lockfile changed in the merge (fire-and-forget async)
    import(path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'worktree-manager.js'))
      .then(wtMgr => {
        const depResult = wtMgr.syncWorktreeDeps(EFFECTIVE_CWD);
        if (depResult.synced) process.stderr.write(`[playwright] Re-installed deps after merge in ${EFFECTIVE_CWD}\n`);
      })
      .catch((depErr: unknown) => {
        process.stderr.write(`[playwright] Warning: dep sync after merge failed: ${(depErr as Error)?.message?.slice(0, 200)}\n`);
      });
    return { fresh: true };
  } catch (err) {
    // Merge conflict or other failure — abort and report
    try {
      execFileSync('git', ['merge', '--abort'], {
        cwd: EFFECTIVE_CWD, encoding: 'utf8', timeout: 5000, stdio: 'pipe',
      });
    } catch { /* abort may fail if no merge in progress */ }
    return {
      fresh: false,
      message: `Worktree is ${behindBy} commit(s) behind origin/${baseBranch} and auto-merge failed (likely conflicts). Create a fresh worktree or resolve conflicts manually.`,
    };
  }
}

// ============================================================================
// Demo Run Tracking
// ============================================================================

const DEMO_RUNS_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'demo-runs.json');
const demoRuns = new Map<number, DemoRunState>();
// Threshold (ms) after which a running demo without polling triggers a stale warning.
// Demos are NEVER auto-killed — warnings are emitted through check_demo_result and hooks instead.
const DEMO_STALE_WARNING_MS = 60_000;
// Milliseconds to wait after detecting suite_end before sending SIGTERM (technical flush buffer).
// success_pause_ms is additive on top of this.
const SUITE_END_KILL_DELAY_MS = 5_000;
// PIDs whose process was terminated after suite_end — treated as 'passed' by the exit handler.
const suiteEndAutoKilledPids = new Set<number>();
// PIDs for which run_demo auto-acquired the display lock — release on demo completion.
const displayLockAutoAcquiredPids = new Set<number>();

function loadPersistedDemoRuns(): void {
  try {
    if (!fs.existsSync(DEMO_RUNS_PATH)) return;
    const data = JSON.parse(fs.readFileSync(DEMO_RUNS_PATH, 'utf-8'));
    if (Array.isArray(data)) {
      for (const entry of data) {
        if (entry.pid && typeof entry.pid === 'number') {
          demoRuns.set(entry.pid, entry);
        }
      }
    }
  } catch {
    // State file corrupt or missing — start fresh
  }
}

function persistDemoRuns(): void {
  try {
    const stateDir = path.dirname(DEMO_RUNS_PATH);
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }
    // Keep only last 20 entries to avoid unbounded growth
    // Exclude trace_summary from persistence — it can be 50KB per entry
    // Exclude runtime-only fields (screenshot_interval — NodeJS.Timeout is not serializable)
    const entries = [...demoRuns.values()]
      .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())
      .slice(0, 20)
      .map(({ trace_summary, screenshot_interval, suite_end_detected_at, interrupt_detected_at, last_polled_at, ...rest }) => rest);
    fs.writeFileSync(DEMO_RUNS_PATH, JSON.stringify(entries, null, 2));
  } catch {
    // Non-fatal — state will be lost on MCP restart
  }
}

// ============================================================================
// Demo Interrupt — Task Pause/Resume via Bypass Request System
// ============================================================================

const STATE_DIR = path.join(PROJECT_DIR, '.claude', 'state');
const BYPASS_DB_PATH = path.join(STATE_DIR, 'bypass-requests.db');
const SESSION_QUEUE_DB_PATH = path.join(STATE_DIR, 'session-queue.db');
const PERSISTENT_TASKS_DB_PATH = path.join(STATE_DIR, 'persistent-tasks.db');

/**
 * Pause the task associated with a demo process via the bypass request system.
 * Called when a demo_interrupted event is detected.
 * Returns the bypass request ID if created, null otherwise.
 */
function pauseTaskForDemoInteraction(demoPid: number, scenarioId?: string): string | null {
  try {
    // 1. Find the associated task via session queue metadata
    if (!fs.existsSync(SESSION_QUEUE_DB_PATH)) return null;
    const queueDb = new Database(SESSION_QUEUE_DB_PATH, { readonly: true });
    let taskId: string | null = null;
    let persistentTaskId: string | null = null;
    let taskTitle: string | null = null;
    let agentId: string | null = null;
    try {
      const row = queueDb.prepare(
        "SELECT metadata, title, agent_id FROM queue_items WHERE pid = ? AND status = 'running' LIMIT 1"
      ).get(demoPid) as { metadata: string | null; title: string | null; agent_id: string | null } | undefined;
      if (row?.metadata) {
        const meta = JSON.parse(row.metadata);
        taskId = meta.taskId ?? null;
        persistentTaskId = meta.persistentTaskId ?? null;
      }
      taskTitle = row?.title ?? null;
      agentId = row?.agent_id ?? null;
    } finally {
      queueDb.close();
    }

    // No task association — skip (CTO running demo interactively)
    const effectiveTaskId = persistentTaskId ?? taskId;
    const effectiveTaskType = persistentTaskId ? 'persistent' : (taskId ? 'todo' : null);
    if (!effectiveTaskId || !effectiveTaskType) return null;

    // 2. Create bypass request
    if (!fs.existsSync(BYPASS_DB_PATH)) return null;
    const bypassDb = new Database(BYPASS_DB_PATH);
    try {
      // Ensure table exists (auto-created by agent-tracker, but be safe)
      bypassDb.exec(`
        CREATE TABLE IF NOT EXISTS bypass_requests (
          id TEXT PRIMARY KEY,
          task_type TEXT NOT NULL CHECK (task_type IN ('persistent', 'todo')),
          task_id TEXT NOT NULL,
          task_title TEXT,
          agent_id TEXT,
          session_queue_id TEXT,
          category TEXT NOT NULL DEFAULT 'general',
          summary TEXT NOT NULL,
          details TEXT,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
          resolution_context TEXT,
          resolved_at TEXT,
          resolved_by TEXT DEFAULT 'cto',
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);

      // Dedup: check for existing pending request
      const existing = bypassDb.prepare(
        "SELECT id FROM bypass_requests WHERE task_type = ? AND task_id = ? AND status = 'pending'"
      ).get(effectiveTaskType, effectiveTaskId) as { id: string } | undefined;
      if (existing) return existing.id;

      const requestId = `bypass-${crypto.randomBytes(6).toString('hex')}`;
      const details = `Demo PID: ${demoPid}${scenarioId ? `, Scenario: ${scenarioId}` : ''}. The CTO pressed Escape during a headed demo and is manually interacting with the browser. Task is paused until the CTO calls stop_demo.`;
      bypassDb.prepare(
        `INSERT INTO bypass_requests (id, task_type, task_id, task_title, agent_id, category, summary, details, status)
         VALUES (?, ?, ?, ?, ?, 'demo_interaction', 'CTO manually interacting with interrupted demo', ?, 'pending')`
      ).run(requestId, effectiveTaskType, effectiveTaskId, taskTitle ?? 'Unknown', agentId ?? 'unknown', details);

      // 3. Pause the underlying task
      if (effectiveTaskType === 'persistent' && fs.existsSync(PERSISTENT_TASKS_DB_PATH)) {
        const ptDb = new Database(PERSISTENT_TASKS_DB_PATH);
        try {
          ptDb.prepare("UPDATE persistent_tasks SET status = 'paused' WHERE id = ? AND status IN ('active', 'draft')").run(effectiveTaskId);
          // Record pause event
          ptDb.prepare(
            "INSERT OR IGNORE INTO events (id, task_id, event_type, details, created_at) VALUES (?, ?, 'paused', ?, datetime('now'))"
          ).run(`evt-${crypto.randomBytes(6).toString('hex')}`, effectiveTaskId, JSON.stringify({ reason: 'cto_demo_interaction', demo_pid: demoPid }));
        } catch { /* Non-fatal */ } finally {
          ptDb.close();
        }
      } else if (effectiveTaskType === 'todo') {
        // Reset todo task to pending (blocks re-spawning via bypass gate)
        const todoDbPath = path.join(PROJECT_DIR, '.claude', 'todo.db');
        if (fs.existsSync(todoDbPath)) {
          const todoDb = new Database(todoDbPath);
          try {
            todoDb.prepare("UPDATE tasks SET status = 'pending' WHERE id = ? AND status = 'in_progress'").run(effectiveTaskId);
          } catch { /* Non-fatal */ } finally {
            todoDb.close();
          }
        }
      }

      // 4. Signal the persistent monitor (if persistent task child)
      if (persistentTaskId) {
        try {
          const signalModulePath = path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'session-signals.js');
          if (fs.existsSync(signalModulePath)) {
            // Find monitor agent_id from session queue
            const qDb = new Database(SESSION_QUEUE_DB_PATH, { readonly: true });
            let monitorAgentId: string | null = null;
            try {
              const monitorRow = qDb.prepare(
                `SELECT agent_id FROM queue_items WHERE lane = 'persistent' AND status = 'running'
                 AND json_extract(metadata, '$.persistentTaskId') = ? LIMIT 1`
              ).get(persistentTaskId) as { agent_id: string } | undefined;
              monitorAgentId = monitorRow?.agent_id ?? null;
            } finally {
              qDb.close();
            }

            if (monitorAgentId) {
              // Dynamic import (fire-and-forget) to avoid hard dependency on hooks module
              const signalMessage = `DEMO INTERACTION PAUSE — Task "${taskTitle ?? effectiveTaskId}" is paused indefinitely.\n\nThe CTO has interrupted the headed demo (PID ${demoPid}) and is manually interacting with the browser. This task is blocked until the CTO finishes and calls stop_demo.\n\nINSTRUCTIONS:\n- Continue working on other sub-tasks that do NOT depend on this task's completion\n- Do NOT attempt workarounds, alternatives, or progress on this specific task\n- Do NOT create fix/retry tasks for this demo — it is not broken, it is paused\n- Wait patiently — this may take minutes, hours, or days\n- Check status via list_bypass_requests filtered by task_id="${effectiveTaskId}"\n- The bypass will be auto-resolved when the CTO calls stop_demo`;
              import(signalModulePath).then((mod: { sendSessionSignal?: (...args: unknown[]) => void }) => {
                if (!mod.sendSessionSignal) return;
                mod.sendSessionSignal(
                  agentId ?? 'playwright-mcp',
                  'system',
                  'Demo Interrupt System',
                  monitorAgentId,
                  'persistent-monitor',
                  'directive',
                  signalMessage,
                  PROJECT_DIR,
                );
              }).catch(() => { /* Non-fatal */ });
            }
          }
        } catch {
          // Non-fatal — signal delivery is best-effort
        }
      }

      return requestId;
    } finally {
      bypassDb.close();
    }
  } catch {
    // Non-fatal — task pause is best-effort
    return null;
  }
}

/**
 * Resume the task associated with an interrupted demo after the CTO finishes interacting.
 * Called from stopDemo when cleaning up an interrupted demo.
 */
function resumeTaskAfterDemoInteraction(entry: DemoRunState): void {
  if (!entry.bypass_request_id) return;

  try {
    if (!fs.existsSync(BYPASS_DB_PATH)) return;
    const bypassDb = new Database(BYPASS_DB_PATH);
    try {
      // Resolve the bypass request
      const row = bypassDb.prepare(
        "SELECT task_type, task_id, task_title FROM bypass_requests WHERE id = ? AND status = 'pending'"
      ).get(entry.bypass_request_id) as { task_type: string; task_id: string; task_title: string | null } | undefined;
      if (!row) return;

      bypassDb.prepare(
        "UPDATE bypass_requests SET status = 'approved', resolution_context = 'CTO completed manual demo interaction', resolved_at = datetime('now') WHERE id = ?"
      ).run(entry.bypass_request_id);

      // Resume persistent task
      if (row.task_type === 'persistent' && fs.existsSync(PERSISTENT_TASKS_DB_PATH)) {
        const ptDb = new Database(PERSISTENT_TASKS_DB_PATH);
        try {
          ptDb.prepare("UPDATE persistent_tasks SET status = 'active' WHERE id = ? AND status = 'paused'").run(row.task_id);
          ptDb.prepare(
            "INSERT OR IGNORE INTO events (id, task_id, event_type, details, created_at) VALUES (?, ?, 'resumed', ?, datetime('now'))"
          ).run(`evt-${crypto.randomBytes(6).toString('hex')}`, row.task_id, JSON.stringify({ reason: 'demo_interaction_complete' }));
        } catch { /* Non-fatal */ } finally {
          ptDb.close();
        }

        // Enqueue monitor revival at critical priority
        try {
          const queueModulePath = path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'session-queue.js');
          if (fs.existsSync(queueModulePath)) {
            // Dynamic import to get enqueueSession
            import(queueModulePath).then((mod: { enqueueSession?: (...args: unknown[]) => unknown }) => {
              if (!mod.enqueueSession) return;
              mod.enqueueSession({
                priority: 'critical',
                lane: 'persistent',
                spawnType: 'fresh',
                title: `Revival: ${row.task_title ?? row.task_id} (demo interaction complete)`,
                agentType: 'persistent-monitor',
                prompt: `You are reviving persistent task ${row.task_id}. The CTO has completed manual interaction with the demo. Resume monitoring.`,
                metadata: { persistentTaskId: row.task_id, revivalReason: 'demo_interaction_complete' },
                source: 'bypass-request-resolve',
              });
            }).catch(() => { /* Non-fatal */ });
          }
        } catch {
          // Non-fatal — revival is best-effort, hourly automation will catch it
        }
      }

      // Signal the monitor that block is cleared
      try {
        const signalModulePath = path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'session-signals.js');
        if (fs.existsSync(signalModulePath) && row.task_type === 'persistent') {
          const qDb = new Database(SESSION_QUEUE_DB_PATH, { readonly: true });
          let monitorAgentId: string | null = null;
          try {
            const monitorRow = qDb.prepare(
              `SELECT agent_id FROM queue_items WHERE lane = 'persistent' AND status = 'running'
               AND json_extract(metadata, '$.persistentTaskId') = ? LIMIT 1`
            ).get(row.task_id) as { agent_id: string } | undefined;
            monitorAgentId = monitorRow?.agent_id ?? null;
          } finally {
            qDb.close();
          }

          if (monitorAgentId) {
            import(signalModulePath).then((mod: { sendSessionSignal?: (...args: unknown[]) => void }) => {
              if (!mod.sendSessionSignal) return;
              mod.sendSessionSignal(
                'playwright-mcp',
                'system',
                'Demo Interrupt System',
                monitorAgentId,
                'persistent-monitor',
                'directive',
                `DEMO INTERACTION COMPLETE — Task "${row.task_title ?? row.task_id}" resumed. The CTO has finished interacting with the demo. You may now proceed with this task.`,
                PROJECT_DIR,
              );
            }).catch(() => { /* Non-fatal */ });
          }
        }
      } catch {
        // Non-fatal
      }
    } finally {
      bypassDb.close();
    }
  } catch {
    // Non-fatal — task resume is best-effort
  }
}

/**
 * Record the current time as the last poll for a demo process.
 * Called on run_demo launch and on each check_demo_result poll.
 * Used to compute stale demo warnings — demos are NEVER auto-killed.
 */
function recordPollTime(pid: number): void {
  const entry = demoRuns.get(pid);
  if (entry) {
    entry.last_polled_at = Date.now();
  }
}

/**
 * Clear poll tracking for a demo process (natural exit or manual stop).
 */
function clearPollTracking(pid: number): void {
  const entry = demoRuns.get(pid);
  if (entry) {
    entry.last_polled_at = undefined;
  }
}

/**
 * Compute a stale warning message for a running demo that hasn't been polled recently.
 * Returns undefined if the demo is not stale.
 */
function computeStaleWarning(pid: number): string | undefined {
  const entry = demoRuns.get(pid);
  if (!entry || (entry.status !== 'running' && entry.status !== 'interrupted')) return undefined;
  const lastPoll = entry.last_polled_at;
  if (!lastPoll) return undefined;
  const elapsed = Date.now() - lastPoll;
  if (elapsed < DEMO_STALE_WARNING_MS) return undefined;
  const staleSec = Math.round(elapsed / 1000);
  return `WARNING: This demo process (PID ${pid}) has not been polled for ${staleSec}s. ` +
    `The demo will NOT be auto-killed, but an unpolled demo wastes resources (browser, display lock, dev server). ` +
    `Call check_demo_result to continue monitoring, or stop_demo to terminate.`;
}

// Load persisted state on startup
loadPersistedDemoRuns();

// Convenience mapping for Next.js projects using Supabase — no-op when these vars are absent.
// Credentials are injected by mcp-launcher.js from 1Password at runtime.
if (process.env.SUPABASE_URL && !process.env.NEXT_PUBLIC_SUPABASE_URL) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL;
}
if (process.env.SUPABASE_ANON_KEY && !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
}

/**
 * Kill any processes listening on the dev server port (default 3000).
 * Prevents zombie servers from previous runs causing port conflicts.
 */
function cleanupDevServerPort(port = 3000): void {
  try {
    const lsofOutput = execFileSync('lsof', ['-ti', `:${port}`], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (lsofOutput) {
      const pids = lsofOutput.split('\n').filter(Boolean);
      for (const pid of pids) {
        try {
          process.kill(Number(pid), 'SIGTERM');
        } catch {
          // Process may have already exited
        }
      }
    }
  } catch {
    // No processes on port — nothing to clean up
  }
}

// ============================================================================
// Pre-flight Validation
// ============================================================================

interface PreflightResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate that required environment variables are set and resolved.
 * Two checks:
 *   1. Unresolved op:// references → credential injection failed
 *   2. When the project uses auth (storageState in config), at least one
 *      credential env var must be present — catches completely missing credentials
 *
 * Project-agnostic: no hardcoded credential key names.
 */

/**
 * Verify build artifact freshness using distVerification config from services.json.
 * Returns an array of warning strings — empty means all checks passed.
 *
 * Checks:
 *  1. Source files are not newer than dist (stale build detection)
 *  2. Expected patterns exist in compiled output (content verification)
 */
function verifyDistArtifacts(): string[] {
  const warnings: string[] = [];

  try {
    const servicesPath = path.join(EFFECTIVE_CWD, 'services.json');
    if (!fs.existsSync(servicesPath)) return warnings;

    const raw = fs.readFileSync(servicesPath, 'utf-8');
    const config = JSON.parse(raw);
    const checks = config.distVerification;
    if (!Array.isArray(checks) || checks.length === 0) return warnings;

    for (const check of checks) {
      const distFullPath = path.join(EFFECTIVE_CWD, check.distPath);

      // Check 1: dist file exists
      if (!fs.existsSync(distFullPath)) {
        warnings.push(`MISSING ARTIFACT: ${check.distPath} does not exist. Build required.`);
        continue;
      }

      // Check 2: source newer than dist (stale build)
      if (check.srcGlob) {
        try {
          const distStat = fs.statSync(distFullPath);
          const distMtime = distStat.mtimeMs;

          // Use a simple directory-level check: find the newest file in the src dir
          const srcDir = path.join(EFFECTIVE_CWD, path.dirname(check.srcGlob.replace(/\*.*$/, '')));
          if (fs.existsSync(srcDir)) {
            const newestSrcMtime = getNewestMtimeInDir(srcDir);
            if (newestSrcMtime > distMtime) {
              warnings.push(`STALE ARTIFACT: ${check.distPath} (modified ${new Date(distMtime).toISOString()}) is older than source in ${check.srcGlob} (modified ${new Date(newestSrcMtime).toISOString()}). Rebuild required.${check.buildCommand ? ` Run: ${check.buildCommand}` : ''}`);
            }
          }
        } catch {
          // Non-fatal — skip mtime check if stat fails
        }
      }

      // Check 3: expected patterns in compiled output
      if (check.expectedPatterns && Array.isArray(check.expectedPatterns)) {
        try {
          const content = fs.readFileSync(distFullPath, 'utf-8');
          for (const pattern of check.expectedPatterns) {
            if (!content.includes(pattern)) {
              warnings.push(`MISSING PATTERN: "${pattern}" not found in ${check.distPath}. The compiled artifact may not contain recent fixes.${check.buildCommand ? ` Rebuild: ${check.buildCommand}` : ''}`);
            }
          }
        } catch {
          // Non-fatal — skip content check if read fails
        }
      }
    }
  } catch {
    // Non-fatal — if services.json is missing or malformed, skip verification
  }

  return warnings;
}

/**
 * Recursively find the newest mtime in a directory (non-recursive, top-level only for performance).
 */
function getNewestMtimeInDir(dirPath: string): number {
  let newest = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isFile()) {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs > newest) newest = stat.mtimeMs;
      } else if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        const subNewest = getNewestMtimeInDir(fullPath);
        if (subNewest > newest) newest = subNewest;
      }
    }
  } catch {
    // Non-fatal
  }
  return newest;
}

function validatePrerequisites(): PreflightResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check 1: Unresolved 1Password references
  for (const [name, value] of Object.entries(process.env)) {
    if (value && value.startsWith('op://')) {
      errors.push(`${name} contains unresolved 1Password reference`);
    }
  }

  // Check 2: When the project uses auth, at least one credential env var should be set.
  // Credential env vars are those injected by mcp-launcher.js from 1Password (typically
  // SUPABASE_URL, DATABASE_URL, API_KEY, etc.). We detect them by checking for env vars
  // that are NOT standard Node/system vars and have non-empty values.
  if (pwConfig.authFiles.length > 0) {
    const credentialVars = Object.entries(process.env).filter(([name, value]) => {
      if (!value || value.startsWith('op://')) return false;
      // Skip known system/Node vars — credential vars are the remainder
      const isSystem = /^(PATH|HOME|USER|SHELL|TERM|LANG|LC_|TMPDIR|PWD|OLDPWD|SHLVL|_|NODE|npm_|CLAUDE_|GENTYR_|HTTPS?_PROXY|NO_PROXY|HOSTNAME|LOGNAME|DISPLAY|XDG_|SSH_|GPG_)/i.test(name);
      return !isSystem;
    });
    if (credentialVars.length === 0) {
      errors.push('No credential environment variables found — 1Password injection may have failed entirely');
    }
  }

  // Check 3: Validate secrets are resolvable from 1Password (not just in process.env)
  // Secrets live in 1Password — they're resolved on-demand by resolveLocalSecrets()/opRead(),
  // NOT injected into process.env. So we test resolvability with a single canary secret.
  try {
    const config = loadServicesConfig(PROJECT_DIR);
    const localSecrets = config.secrets?.local || {};
    const secretRefs = Object.entries(localSecrets);
    if (secretRefs.length > 0) {
      // Test the first secret as a canary — if 1Password is reachable and the vault
      // mapping is correct, all secrets should be resolvable
      const [canaryKey, canaryRef] = secretRefs[0];
      try {
        opRead(canaryRef);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`Cannot resolve secrets from 1Password (tested ${canaryKey}): ${message}`);
      }
    }
  } catch {
    // services.json not available — fall through to existing heuristic
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ============================================================================
// Shared Demo Helpers
// ============================================================================

/**
 * Build a clean environment for demo child processes.
 * Strips infrastructure credentials, resolves 1Password secrets, applies demo-specific vars.
 */
function buildDemoEnv(opts: {
  slow_mo?: number;
  headless?: boolean;
  base_url?: string;
  trace?: boolean;
  extra_env?: Record<string, string>;
  progress_file?: string;
  dev_server_ready?: boolean;
  run_id?: string;
  telemetry?: boolean;
  telemetry_dir?: string;
}): Record<string, string> {
  const env: Record<string, string> = { ...process.env as Record<string, string> };

  // Strip infrastructure credentials from child env (unconditional)
  for (const key of INFRA_CRED_KEYS) delete env[key];

  // Resolve 1Password secrets for child process (fail-closed: missing credentials = abort)
  try {
    const config = loadServicesConfig(PROJECT_DIR);
    const { resolvedEnv, failedKeys, failureDetails } = resolveLocalSecrets(config);
    Object.assign(env, resolvedEnv);

    if (failedKeys.length > 0) {
      const details = failedKeys.map(k => `  ${k}: ${failureDetails[k] || 'unknown error'}`).join('\n');
      throw new Error(`Failed to resolve credentials:\n${details}\nThese op:// references could not be resolved by the MCP server.`);
    }

    // Apply project-specific dev-mode env — always inject since it may contain
    // env vars (e.g., SUPABASE_URL) needed regardless of dev server health
    if (config.demoDevModeEnv) {
      Object.assign(env, config.demoDevModeEnv);
    }
  } catch (err) {
    // Re-throw to caller — launching with missing credentials wastes sessions
    throw err;
  }

  if (opts.progress_file) env.DEMO_PROGRESS_FILE = opts.progress_file;
  if (opts.run_id) env.DEMO_RUN_ID = opts.run_id;
  if (opts.telemetry) env.DEMO_TELEMETRY = '1';
  if (opts.telemetry_dir) env.DEMO_TELEMETRY_DIR = opts.telemetry_dir;
  if (opts.slow_mo !== undefined) env.DEMO_SLOW_MO = String(opts.slow_mo);
  if (opts.headless) env.DEMO_HEADLESS = '1';
  if (opts.base_url) env.PLAYWRIGHT_BASE_URL = opts.base_url;

  // Always show cursor dot in headed demos
  env.DEMO_SHOW_CURSOR = '1';

  // Maximize browser window in headed demos for cleaner recordings
  if (!opts.headless) env.DEMO_MAXIMIZE = '1';

  // Enable Metal GPU acceleration on macOS for smoother headed demos
  if (process.platform === 'darwin') env.DEMO_METAL_GPU = '1';

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

  // Auto-inject browser telemetry capture via --import (when telemetry enabled)
  if (opts.telemetry) {
    const telemetrySetupPath = path.resolve(PROJECT_DIR, '.claude/hooks/lib/playwright-telemetry-setup.mjs');
    try {
      fs.accessSync(telemetrySetupPath);
      if (!(env.NODE_OPTIONS || '').includes('playwright-telemetry-setup')) {
        env.NODE_OPTIONS = ((env.NODE_OPTIONS || '') + ` --import "${telemetrySetupPath}"`).trim();
      }
    } catch { /* telemetry setup not available — skip */ }
  }

  // Apply extra_env last — may override explicit demo vars (same as original inline behavior)
  if (opts.extra_env) {
    Object.assign(env, opts.extra_env);
  }

  return env;
}

/**
 * Persist a video recording for a demo scenario.
 * Copies the video to .claude/recordings/demos/ and updates the DB.
 */
function persistScenarioRecording(scenarioId: string, videoPath: string): void {
  try {
    if (!fs.existsSync(videoPath)) return;
    const recordingsDir = path.join(PROJECT_DIR, '.claude', 'recordings', 'demos');
    fs.mkdirSync(recordingsDir, { recursive: true });
    const destPath = path.join(recordingsDir, `${scenarioId}.mp4`);
    fs.copyFileSync(videoPath, destPath);

    const userFeedbackDbPath = getUserFeedbackDbPath();
    const db = new Database(userFeedbackDbPath);
    try {
      db.prepare(
        'UPDATE demo_scenarios SET last_recorded_at = ?, recording_path = ? WHERE id = ?'
      ).run(new Date().toISOString(), destPath, scenarioId);
    } finally {
      db.close();
    }
  } catch {
    // Non-fatal — recording persistence is best-effort
  }
}

/**
 * Persist a demo result row to user-feedback.db demo_results table.
 * Mirrors the CTO Dashboard's recordDemoResult() so agent-initiated demo runs
 * are tracked in the same table as dashboard-initiated runs.
 * Non-fatal: never blocks demo execution.
 */
function persistDemoResult(opts: {
  scenarioId: string;
  status: 'passed' | 'failed';
  executionMode: 'local' | 'remote';
  startedAt: string;
  completedAt: string;
  durationMs: number;
  flyMachineId?: string;
  branch?: string;
  failureReason?: string;
  recordingPath?: string;
}): void {
  try {
    const dbPath = getUserFeedbackDbPath();
    if (!fs.existsSync(dbPath)) return;
    const db = new Database(dbPath);
    try {
      // Defensive column auto-migration (same pattern as CTO Dashboard process-runner.ts)
      try { db.prepare('SELECT branch FROM demo_results LIMIT 0').run(); } catch { db.exec('ALTER TABLE demo_results ADD COLUMN branch TEXT'); }
      try { db.prepare('SELECT failure_reason FROM demo_results LIMIT 0').run(); } catch { db.exec('ALTER TABLE demo_results ADD COLUMN failure_reason TEXT'); }
      try { db.prepare('SELECT recording_path FROM demo_results LIMIT 0').run(); } catch { db.exec('ALTER TABLE demo_results ADD COLUMN recording_path TEXT'); }

      // Look up recording path from scenario if passed and not explicitly provided
      let recordingPath = opts.recordingPath ?? null;
      if (opts.status === 'passed' && !recordingPath) {
        const row = db.prepare('SELECT recording_path FROM demo_scenarios WHERE id = ?').get(opts.scenarioId) as { recording_path?: string } | undefined;
        if (row?.recording_path && fs.existsSync(row.recording_path)) {
          recordingPath = row.recording_path;
        }
      }

      db.prepare(
        `INSERT INTO demo_results (id, scenario_id, execution_mode, status, started_at, completed_at, duration_ms, fly_machine_id, branch, failure_reason, recording_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        crypto.randomUUID(),
        opts.scenarioId,
        opts.executionMode,
        opts.status,
        opts.startedAt,
        opts.completedAt,
        opts.durationMs,
        opts.flyMachineId ?? null,
        opts.branch ?? null,
        opts.failureReason ?? null,
        recordingPath,
      );
    } finally {
      db.close();
    }
  } catch {
    // Non-fatal — result persistence must never block demo execution
  }
}

// ============================================================================
// Shared Failure Classifier
// ============================================================================

/**
 * Classify a demo failure based on exit code, stderr, machine logs, and progress.
 * Used by both single-demo check_demo_result and batch per-scenario completion to
 * provide consistent, actionable failure diagnostics.
 */
function classifyFailure(opts: {
  exitCode: number;
  stderrTail?: string;
  machineLog?: string;
  durationSeconds: number;
  computeSizeUsed?: string;
  scenarioId?: string;
  progress?: DemoProgress | null;
}): FailureClassificationResult {
  const { exitCode, stderrTail = '', machineLog = '', durationSeconds, computeSizeUsed, scenarioId, progress } = opts;

  // OOM: exit 137 OR OOM patterns in stderr OR kernel OOM killer in machine log
  const stderrOomPattern = /out of memory|oom|cannot allocate|killed.*signal 9|SIGKILL/i;
  const machineLogOomPattern = /oom.killer|Out of memory|Killed process/i;
  if (exitCode === 137 || stderrOomPattern.test(stderrTail) || machineLogOomPattern.test(machineLog)) {
    const currentSize = computeSizeUsed || 'standard';
    let suggestion: string;
    if (currentSize !== 'large') {
      suggestion = `Demo was killed (likely OOM — exit code ${exitCode}). Current: ${currentSize} (4GB). ` +
        `Fix: update_demo_scenario({ id: "${scenarioId || 'SCENARIO_ID'}", compute_size: "large" })`;
    } else {
      suggestion = `Demo was killed (likely OOM — exit code ${exitCode}) even at large (8GB). ` +
        `Investigate memory usage — the demo may have a memory leak.`;
    }
    return {
      classification: 'oom',
      reason: `Process killed with exit code ${exitCode} — OOM pattern detected`,
      suggestion,
    };
  }

  // Startup failure: machine alive < 30s
  if (durationSeconds < 30) {
    return {
      classification: 'startup_failure',
      reason: `Machine exited after only ${durationSeconds}s — likely a startup/clone/install failure`,
      suggestion: 'Check stderr_tail for clone or install errors. The git ref or dependencies may be broken.',
    };
  }

  // Timeout: stall detector pattern in stderr
  if (/STALL DETECTED/i.test(stderrTail)) {
    return {
      classification: 'timeout',
      reason: 'Stall detector killed the process — demo stopped producing output',
      suggestion: 'Add [demo-progress] checkpoints or increase stall_timeout_ms. The demo may be stuck in an infinite loop or waiting for a UI element that never appears.',
    };
  }

  // External kill: SIGTERM in stderr (Fly.io or hourly cleanup killed the machine)
  if (/SIGTERM/i.test(stderrTail)) {
    return {
      classification: 'external_kill',
      reason: 'Process received SIGTERM — machine was killed externally (Fly.io stop or cleanup)',
      suggestion: 'This is typically a transient infra failure. Retry the scenario.',
    };
  }

  // Build failure: workspace packages not built, esbuild errors, dist missing
  const buildFailurePattern = /dist\/index\.js.*not found|Cannot find module.*dist|esbuild.*error|ERR_MODULE_NOT_FOUND.*dist|ENOENT.*dist\/|build.*failed|tsc.*error/i;
  if (buildFailurePattern.test(stderrTail)) {
    return {
      classification: 'build_failure',
      reason: 'Workspace build failure — dependency dist/ artifacts missing on Fly.io',
      suggestion: 'The project needs pnpm --recursive build before tests. Either: (1) add worktreeBuildCommand to services.json, (2) use worktreeArtifactCopy to copy dist/ from main tree, or (3) deploy a project-specific Fly.io image with deploy_project_image().',
    };
  }

  // Test failure: progress shows failures + exit > 0 and < 128 (normal failure codes)
  if (progress?.has_failures && exitCode > 0 && exitCode < 128) {
    return {
      classification: 'test_failure',
      reason: `${progress.tests_failed} test(s) failed out of ${progress.tests_completed}`,
    };
  }

  // Recording failure: ffmpeg errors
  if (/ffmpeg.*error|recording.*fail/i.test(stderrTail)) {
    return {
      classification: 'recording_failure',
      reason: 'Recording infrastructure (ffmpeg/Xvfb) failed',
      suggestion: 'The test itself may have passed but recording failed. Check if the demo needs headed mode or if ffmpeg crashed.',
    };
  }

  // Unknown — fallback
  return {
    classification: 'unknown',
    reason: `Exit code: ${exitCode} — no specific failure pattern matched`,
    suggestion: 'Check stderr_tail and fly_machine_log for clues. Consider running the demo locally with run_demo({ remote: false }) to reproduce.',
  };
}

/**
 * Get the current git branch name. Returns null on detached HEAD or error.
 */
function getDemoBranch(): string | null {
  try {
    const ref = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: EFFECTIVE_CWD, encoding: 'utf8', timeout: 5000,
    }).trim();
    return ref === 'HEAD' ? null : ref;
  } catch {
    return null;
  }
}

// ============================================================================
// Window Recording Helpers (ScreenCaptureKit-based, macOS only)
// ============================================================================

/**
 * Resolve the WindowRecorder binary path relative to the framework root.
 * From dist/playwright/ we walk up to the framework root, then into tools/.
 * Returns null on non-Darwin platforms or if the binary doesn't exist.
 */
let _windowRecorderBinary: string | null | undefined;
function getWindowRecorderBinary(): string | null {
  if (_windowRecorderBinary !== undefined) return _windowRecorderBinary;
  if (os.platform() !== 'darwin') {
    _windowRecorderBinary = null;
    return null;
  }
  // __dirname is dist/playwright/ — walk up to framework root
  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 5; i++) {
    const buildPath = path.join(dir, 'tools', 'window-recorder', '.build', 'release', 'WindowRecorder');
    if (fs.existsSync(buildPath)) {
      // Copy to a runtime location outside .build/ to avoid macOS Sequoia's
      // path-based ScreenCaptureKit denial cache. On Sequoia 15.6+, if a binary
      // at a specific path is ever denied screen recording permission, that denial
      // is cached permanently by path (surviving tccd/replayd restarts and reboots).
      // Copying to a sibling path sidesteps this cache entirely.
      const runtimePath = path.join(dir, 'tools', 'window-recorder', 'WindowRecorder');
      try {
        // Only copy if build is newer than runtime copy (or runtime doesn't exist)
        const buildStat = fs.statSync(buildPath);
        const runtimeStat = fs.existsSync(runtimePath) ? fs.statSync(runtimePath) : null;
        if (!runtimeStat || buildStat.mtimeMs > runtimeStat.mtimeMs) {
          fs.copyFileSync(buildPath, runtimePath);
          fs.chmodSync(runtimePath, 0o755);
        }
        _windowRecorderBinary = runtimePath;
        return runtimePath;
      } catch {
        // Fall back to build path if copy fails
        _windowRecorderBinary = buildPath;
        return buildPath;
      }
    }
    dir = path.dirname(dir);
  }
  _windowRecorderBinary = null;
  return null;
}

/**
 * Start the WindowRecorder process for a demo.
 * The recorder polls for up to 30s internally, so it's safe to start before Chromium opens.
 * Returns process info or null if the binary isn't available.
 */
// Track recorder diagnostics per-PID so runDemo can report failures
const recorderDiagnostics = new Map<number, { exitCode: number | null; stderr: string; startedAt: number }>();

function startWindowRecorder(outputPath: string, appName?: string): { pid: number; process: ReturnType<typeof spawn> } | null {
  const binary = getWindowRecorderBinary();
  if (!binary) return null;

  // Always pass --skip-snapshot because we start the recorder AFTER Chrome is already running.
  // The snapshot-based new-window filter would exclude Chrome's pre-existing window forever.
  const args = ['--output', outputPath, '--skip-snapshot'];
  if (appName) args.push('--app', appName);

  try {
    const child = spawn(binary, args, {
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      cwd: EFFECTIVE_CWD,
    });
    child.unref();

    const diag = { exitCode: null as number | null, stderr: '', startedAt: Date.now() };

    child.stderr?.on('data', (chunk: Buffer) => { diag.stderr += chunk.toString('utf8'); });
    child.on('exit', (code) => {
      diag.exitCode = code;
      if (code !== 0 && code !== null) {
        process.stderr.write(`[playwright] WindowRecorder exited with code ${code}: ${diag.stderr.trim().slice(0, 500)}\n`);
      }
      // Exit code 2 = Screen Recording permission denied. Propagate the error message
      // into the associated DemoRunState so check_demo_result surfaces it clearly
      // instead of reporting recording_source: "none" with no explanation.
      if (code === 2 && child.pid) {
        const permissionError = diag.stderr.trim().slice(0, 2000) ||
          'WindowRecorder exited with code 2: Screen Recording permission is denied for this process.';
        for (const state of demoRuns.values()) {
          if (state.window_recorder_pid === child.pid) {
            state.window_recorder_permission_error = permissionError;
            state.window_recorder_pid = undefined;
            break;
          }
        }
      }
    });

    if (!child.pid) return null;
    recorderDiagnostics.set(child.pid, diag);
    return { pid: child.pid, process: child };
  } catch {
    return null;
  }
}

/**
 * Stop a running WindowRecorder synchronously.
 * For use in sync contexts like event handlers.
 */
function stopWindowRecorderSync(pid: number, outputPath: string): boolean {
  try {
    try { process.kill(pid, 'SIGINT'); } catch { /* already dead */ }

    let exited = false;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        exited = true;
        break;
      }
      const spinEnd = Date.now() + 500;
      while (Date.now() < spinEnd) { /* spin */ }
    }

    if (!exited) {
      // Process still alive at deadline — SIGKILL corrupts the MP4 (no moov atom)
      process.stderr.write(`[playwright] WindowRecorder PID ${pid} did not exit within 30s — sending SIGKILL (recording will be corrupted)\n`);
      try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
      return false;
    }

    return fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0;
  } catch {
    return false;
  }
}

// ============================================================================
// Fullscreen Helpers (macOS only)
// ============================================================================

/**
 * Wait for a Chrome for Testing window to appear (macOS only).
 */
async function waitForChromeWindow(timeoutMs: number = 30000): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFileAsync('osascript', ['-e',
        'tell application "System Events" to return (count of windows of process "Google Chrome for Testing") > 0'
      ], { timeout: 3000, encoding: 'utf8' });
      if (stdout.trim() === 'true') return true;
    } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

// ============================================================================
// Chrome Window ID Discovery (macOS only)
// ============================================================================

/**
 * Get the CGWindowID for Chrome for Testing's main window (macOS only).
 * Uses swift + CoreGraphics to query CGWindowListCopyWindowInfo.
 * Returns null on non-macOS or if no matching window is found.
 */
async function getChromeWindowId(): Promise<number | null> {
  if (process.platform !== 'darwin') return null;
  try {
    const script = `
import CoreGraphics
let windowList = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] ?? []
for w in windowList {
    guard let name = w[kCGWindowOwnerName as String] as? String else { continue }
    if name.contains("Chrome for Testing"), let layer = w[kCGWindowLayer as String] as? Int, layer == 0 {
        let bounds = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
        let width = bounds["Width"] as? Int ?? 0
        let height = bounds["Height"] as? Int ?? 0
        if width >= 100 && height >= 100 {
            if let windowId = w[kCGWindowNumber as String] as? Int { print(windowId) }
            break
        }
    }
}`;
    const { stdout } = await execFileAsync('swift', ['-e', script], {
      timeout: 10000,
      encoding: 'utf8',
    });
    const id = parseInt(stdout.trim(), 10);
    return isNaN(id) ? null : id;
  } catch {
    return null;
  }
}

// ============================================================================
// Screenshot Capture Helpers (macOS only)
// ============================================================================

const SCREENSHOT_INTERVAL_MS = 3000;

/**
 * Start periodic screenshot capture using macOS screencapture.
 * When windowId is provided, captures only that specific window via -l <windowId>.
 * Falls back to full-screen capture when windowId is null/undefined.
 * Returns null on non-macOS platforms.
 */
function startScreenshotCapture(
  scenarioId: string,
  windowId?: number | null,
): { interval: ReturnType<typeof setInterval>; dir: string; startTime: number } | null {
  if (os.platform() !== 'darwin') return null;

  const dir = path.join(
    PROJECT_DIR,
    '.claude',
    'recordings',
    'demos',
    scenarioId,
    'screenshots',
  );
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return null;
  }

  const startTime = Date.now();

  const captureOne = () => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const filename = `screenshot-${String(elapsed).padStart(4, '0')}.png`;
    const filepath = path.join(dir, filename);
    try {
      const captureArgs = ['-x', '-t', 'png'];
      if (windowId != null) captureArgs.push('-l', String(windowId));
      captureArgs.push(filepath);
      execFileSync('screencapture', captureArgs, {
        timeout: 5000,
        stdio: 'pipe',
      });
    } catch {
      // Non-fatal — screencapture may fail if no display
    }
  };

  captureOne();
  const interval = setInterval(captureOne, SCREENSHOT_INTERVAL_MS);
  interval.unref(); // Don't prevent MCP process exit

  return { interval, dir, startTime };
}

/**
 * Stop periodic screenshot capture.
 */
function stopScreenshotCapture(interval: ReturnType<typeof setInterval>): void {
  clearInterval(interval);
}

/**
 * Extract frames from a video file using ffmpeg.
 * Returns frames at 0.5s intervals within the given time range.
 * Clamps range to [0, video_duration].
 */
function extractFramesFromVideo(
  videoPath: string,
  centerSeconds: number,
  radiusSeconds: number = 3,
): { frames: Array<{ file_path: string; timestamp_seconds: number }>; range: { start_seconds: number; end_seconds: number } } | { error: string } {
  if (!fs.existsSync(videoPath)) {
    return { error: `Video file not found: ${videoPath}` };
  }

  // Get video duration via ffprobe
  let videoDuration: number;
  try {
    const probe = execFileSync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath,
    ], { encoding: 'utf8', timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] });
    videoDuration = parseFloat(probe.trim());
    if (isNaN(videoDuration) || videoDuration <= 0) {
      return { error: 'Could not determine video duration.' };
    }
  } catch {
    return { error: 'ffprobe failed — is ffmpeg installed? (brew install ffmpeg)' };
  }

  // Clamp range to video bounds
  const startSec = Math.max(0, centerSeconds - radiusSeconds);
  const endSec = Math.min(videoDuration, centerSeconds + radiusSeconds);

  // Create output directory
  const videoDir = path.dirname(videoPath);
  const videoBase = path.basename(videoPath, '.mp4');
  const framesDir = path.join(videoDir, `${videoBase}-frames`);

  // Clean up old frames from previous extraction for same video
  try {
    if (fs.existsSync(framesDir)) {
      fs.rmSync(framesDir, { recursive: true, force: true });
    }
    fs.mkdirSync(framesDir, { recursive: true });
  } catch {
    return { error: `Failed to create frames directory: ${framesDir}` };
  }

  // Extract frames at 0.5s intervals using ffmpeg
  // -ss before -i = input seeking; -t = duration from seek point (NOT -to which is absolute)
  try {
    execFileSync('ffmpeg', [
      '-y',
      '-ss', String(startSec),
      '-t', String(endSec - startSec),
      '-i', videoPath,
      '-vf', 'fps=2',
      '-frame_pts', '1',
      path.join(framesDir, 'frame-%04d.png'),
    ], { timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    // ffmpeg may fail but still produce some frames
    const errMsg = err instanceof Error ? err.message : String(err);
    if (!fs.existsSync(framesDir) || fs.readdirSync(framesDir).filter(f => f.endsWith('.png')).length === 0) {
      return { error: `ffmpeg frame extraction failed: ${errMsg.slice(0, 200)}` };
    }
  }

  // Collect extracted frames and assign timestamps
  const frameFiles = fs.readdirSync(framesDir)
    .filter(f => f.endsWith('.png'))
    .sort();

  const frames: Array<{ file_path: string; timestamp_seconds: number }> = [];
  for (let i = 0; i < frameFiles.length; i++) {
    const timestamp = Math.round((startSec + i * 0.5) * 10) / 10; // Round to 1 decimal
    frames.push({
      file_path: path.join(framesDir, frameFiles[i]),
      timestamp_seconds: timestamp,
    });
  }

  return {
    frames,
    range: { start_seconds: Math.round(startSec * 10) / 10, end_seconds: Math.round(endSec * 10) / 10 },
  };
}

/**
 * Extract periodic screenshots from a video recording at fixed intervals.
 *
 * Used by the remote demo path to produce screenshot files identical to the
 * local macOS `screencapture` periodic capture system. Filenames follow the
 * local convention: `screenshot-XXXX.png` where XXXX is elapsed seconds.
 *
 * @returns Number of screenshots extracted, or 0 on failure.
 */
function extractScreenshotsFromRecording(
  recordingPath: string,
  screenshotDir: string,
  intervalSeconds: number = 3,
): number {
  if (!fs.existsSync(recordingPath)) return 0;

  fs.mkdirSync(screenshotDir, { recursive: true });

  // Clean stale screenshots from a prior run (avoids stale timestamps from longer recordings)
  try {
    for (const f of fs.readdirSync(screenshotDir).filter(f => f.startsWith('screenshot-') && f.endsWith('.png'))) {
      fs.unlinkSync(path.join(screenshotDir, f));
    }
  } catch { /* non-fatal */ }

  // Extract one frame per intervalSeconds
  try {
    execFileSync('ffmpeg', [
      '-y',
      '-i', recordingPath,
      '-vf', `fps=1/${intervalSeconds}`,
      path.join(screenshotDir, 'frame-%04d.png'),
    ], { timeout: 120_000, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    // ffmpeg may fail but still produce some frames
    const produced = fs.existsSync(screenshotDir)
      ? fs.readdirSync(screenshotDir).filter(f => f.startsWith('frame-') && f.endsWith('.png')).length
      : 0;
    if (produced === 0) return 0;
  }

  // Rename to match local naming: screenshot-XXXX.png (XXXX = elapsed seconds)
  const rawFiles = fs.readdirSync(screenshotDir)
    .filter(f => f.startsWith('frame-') && f.endsWith('.png'))
    .sort();

  for (let i = 0; i < rawFiles.length; i++) {
    const elapsed = i * intervalSeconds;
    const newName = `screenshot-${String(elapsed).padStart(4, '0')}.png`;
    fs.renameSync(
      path.join(screenshotDir, rawFiles[i]),
      path.join(screenshotDir, newName),
    );
  }

  return rawFiles.length;
}

// ============================================================================
// Tool Implementations
// ============================================================================

/**
 * Launch Playwright in interactive UI mode.
 * Validates prerequisites, spawns a detached process, and monitors for early crashes.
 */
async function launchUiMode(args: LaunchUiModeArgs): Promise<LaunchUiModeResult> {
  const { project, base_url, test_file } = args;

  // Pre-flight validation
  const preflight = validatePrerequisites();
  if (!preflight.ok) {
    return {
      success: false,
      project,
      message: `Environment validation failed:\n${preflight.errors.map(e => `  - ${e}`).join('\n')}`,
    };
  }

  const cmdArgs = ['playwright', 'test', '--project', project, '--ui'];
  const env: Record<string, string> = { ...process.env as Record<string, string> };

  // Strip infrastructure credentials from child env (unconditional)
  for (const key of INFRA_CRED_KEYS) delete env[key];

  // Resolve 1Password secrets for child process (non-fatal)
  try {
    const config = loadServicesConfig(PROJECT_DIR);
    const { resolvedEnv } = resolveLocalSecrets(config);
    Object.assign(env, resolvedEnv);
  } catch (err) {
    process.stderr.write(`[playwright] Secret resolution skipped: ${err instanceof Error ? err.message : err}\n`);
  }

  // Insert test_file as positional arg (after 'test', before '--project')
  if (test_file) {
    cmdArgs.splice(2, 0, test_file);
  }

  if (base_url) {
    env.PLAYWRIGHT_BASE_URL = base_url;
  }

  try {
    const child = spawn('npx', cmdArgs, {
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      cwd: EFFECTIVE_CWD,
      env,
    });

    // Collect stderr for crash diagnostics
    let stderrChunks: Buffer[] = [];
    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });
    }

    // Wait up to 3s for early crash detection
    const earlyExit = await new Promise<{ code: number | null; signal: string | null } | null>(
      (resolve) => {
        const timer = setTimeout(() => resolve(null), 3000);

        child.on('exit', (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        });

        child.on('error', (err) => {
          clearTimeout(timer);
          resolve({ code: 1, signal: err.message });
        });
      }
    );

    if (earlyExit) {
      // Process died within 3s — report the failure
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      const snippet = stderr.length > 500 ? stderr.slice(0, 500) + '...' : stderr;
      return {
        success: false,
        project,
        message: `Playwright process crashed within 3s (exit code: ${earlyExit.code}, signal: ${earlyExit.signal})${snippet ? `\nstderr: ${snippet}` : ''}`,
      };
    }

    // Still running after 3s — detach and return success
    if (child.stderr) {
      child.stderr.removeAllListeners('data');
      child.stderr.resume(); // keep pipe open and draining to prevent SIGPIPE
    }
    child.unref();

    const warningText = preflight.warnings.length > 0
      ? `\nWarnings:\n${preflight.warnings.map(w => `  - ${w}`).join('\n')}`
      : '';

    return {
      success: true,
      project,
      message: `Playwright UI mode launched for project "${project}".${test_file ? ` Filtered to: ${test_file}.` : ''} The browser window should open shortly.${warningText}`,
      pid: child.pid,
      test_file,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      project,
      message: `Failed to launch Playwright UI: ${message}`,
    };
  }
}

/**
 * Run a shell command with stall detection.
 * Kills the child if no stdout/stderr output for `stallMs` (default 60s).
 * Also enforces a hard total timeout.
 */
function runWithStallDetection(
  command: string,
  opts: { cwd: string; timeoutMs: number; stallMs?: number; env?: Record<string, string> },
): Promise<{ success: boolean; output: string; error?: string }> {
  const stallMs = opts.stallMs ?? 60_000;
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (result: { success: boolean; output: string; error?: string }) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(totalTimer);
      clearInterval(stallChecker);
      resolve(result);
    };

    const child = spawn('sh', ['-c', command], {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: opts.env,
    });

    let output = '';
    let lastOutputAt = Date.now();

    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      lastOutputAt = Date.now();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      lastOutputAt = Date.now();
    });

    const totalTimer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ success: false, output, error: `Command timed out after ${opts.timeoutMs}ms` });
    }, opts.timeoutMs);
    totalTimer.unref();

    const stallChecker = setInterval(() => {
      if (Date.now() - lastOutputAt > stallMs) {
        child.kill('SIGKILL');
        finish({ success: false, output, error: `Command stalled (no output for ${stallMs / 1000}s)` });
      }
    }, 5_000);
    stallChecker.unref();

    child.on('close', (code) => {
      finish(code === 0
        ? { success: true, output }
        : { success: false, output, error: `Exit code ${code}` });
    });
    child.on('error', (err) => {
      finish({ success: false, output, error: err.message });
    });
  });
}

/**
 * Execute demo prerequisites from user-feedback.db.
 * Runs health checks first — if a prerequisite's health check passes (exit 0),
 * its setup command is skipped (idempotent).
 * Background prerequisites are spawned detached and polled via health check.
 *
 * Scope resolution: global prerequisites always run first, then persona-specific,
 * then scenario-specific. Within each scope, ordered by sort_order ASC.
 */
async function executePrerequisites(opts: {
  scenario_id?: string;
  persona_id?: string;
  dry_run?: boolean;
  base_url?: string;
}): Promise<RunPrerequisitesResult> {
  const dbPath = getUserFeedbackDbPath();
  const entries: PrerequisiteExecEntry[] = [];

  if (!fs.existsSync(dbPath)) {
    return { success: true, total: 0, passed: 0, failed: 0, skipped: 0, entries, message: 'No user-feedback.db found — no prerequisites configured' };
  }

  let db: InstanceType<typeof Database>;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return { success: true, total: 0, passed: 0, failed: 0, skipped: 0, entries, message: 'Could not open user-feedback.db — skipping prerequisites' };
  }

  try {
    // Check table exists
    const tableCheck = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='demo_prerequisites'"
    ).get() as { name: string } | undefined;
    if (!tableCheck) {
      return { success: true, total: 0, passed: 0, failed: 0, skipped: 0, entries, message: 'No demo_prerequisites table — no prerequisites configured' };
    }

    // Resolve persona_id from scenario_id if needed
    let personaId = opts.persona_id;
    if (opts.scenario_id && !personaId) {
      const scenario = db.prepare('SELECT persona_id FROM demo_scenarios WHERE id = ?').get(opts.scenario_id) as { persona_id: string } | undefined;
      if (scenario) personaId = scenario.persona_id;
    }

    // Build query: always include global, optionally persona and scenario
    const scopeConditions: string[] = ["scope = 'global'"];
    const params: string[] = [];

    if (personaId) {
      scopeConditions.push("(scope = 'persona' AND persona_id = ?)");
      params.push(personaId);
    }
    if (opts.scenario_id) {
      scopeConditions.push("(scope = 'scenario' AND scenario_id = ?)");
      params.push(opts.scenario_id);
    }

    const query = `SELECT * FROM demo_prerequisites WHERE enabled = 1 AND (${scopeConditions.join(' OR ')}) ORDER BY CASE scope WHEN 'global' THEN 0 WHEN 'persona' THEN 1 WHEN 'scenario' THEN 2 END, sort_order ASC`;

    const prerequisites = db.prepare(query).all(...params) as Array<{
      id: string;
      command: string;
      description: string;
      timeout_ms: number;
      health_check: string | null;
      health_check_timeout_ms: number;
      scope: string;
      run_as_background: number;
    }>;

    if (prerequisites.length === 0) {
      return { success: true, total: 0, passed: 0, failed: 0, skipped: 0, entries, message: 'No matching prerequisites found' };
    }

    if (opts.dry_run) {
      for (const prereq of prerequisites) {
        entries.push({
          id: prereq.id,
          description: prereq.description,
          scope: prereq.scope,
          health_check_result: prereq.health_check ? 'skipped' : 'not_configured',
          command_result: 'skipped',
          duration_ms: 0,
        });
      }
      return { success: true, total: prerequisites.length, passed: 0, failed: 0, skipped: prerequisites.length, entries, message: `Dry run: ${prerequisites.length} prerequisite(s) would execute` };
    }

    // Resolve 1Password secrets for prerequisite commands (non-fatal)
    let resolvedEnv: Record<string, string> = {};
    try {
      const config = loadServicesConfig(PROJECT_DIR);
      const result = resolveLocalSecrets(config);
      resolvedEnv = result.resolvedEnv;

      // Apply project-specific dev-mode env to prerequisites (e.g., E2E_REBUILD_EXTENSION, EXT_API_BASE)
      if (config.demoDevModeEnv) {
        Object.assign(resolvedEnv, config.demoDevModeEnv);
      }
    } catch {
      // Secret resolution unavailable — prerequisites run with process.env only
    }

    // Inject base URL for prerequisites that invoke Playwright
    if (opts.base_url) {
      resolvedEnv['PLAYWRIGHT_BASE_URL'] = opts.base_url;
    }

    // When running in a worktree, set PORT to the allocated web port so dev servers
    // (Next.js, Vite, etc.) listen on the correct port instead of their default (3000).
    // Also inject backend/bridge ports for multi-service setups.
    if (process.env.PLAYWRIGHT_WEB_PORT) {
      resolvedEnv['PORT'] = process.env.PLAYWRIGHT_WEB_PORT;
      resolvedEnv['PLAYWRIGHT_WEB_PORT'] = process.env.PLAYWRIGHT_WEB_PORT;
    }
    if (process.env.PLAYWRIGHT_BACKEND_PORT) {
      resolvedEnv['PLAYWRIGHT_BACKEND_PORT'] = process.env.PLAYWRIGHT_BACKEND_PORT;
    }
    if (process.env.PLAYWRIGHT_BRIDGE_PORT) {
      resolvedEnv['PLAYWRIGHT_BRIDGE_PORT'] = process.env.PLAYWRIGHT_BRIDGE_PORT;
    }

    // Execute each prerequisite
    let passed = 0;
    let failed = 0;
    let skipped = 0;

    for (const prereq of prerequisites) {
      const startTime = Date.now();
      const entry: PrerequisiteExecEntry = {
        id: prereq.id,
        description: prereq.description,
        scope: prereq.scope,
        health_check_result: 'not_configured',
        command_result: 'skipped',
        duration_ms: 0,
      };

      try {
        // Step 1: Check health_check first (if configured)
        if (prereq.health_check) {
          try {
            execFileSync('sh', ['-c', prereq.health_check], {
              cwd: EFFECTIVE_CWD,
              timeout: prereq.health_check_timeout_ms,
              stdio: 'pipe',
              encoding: 'utf8',
              env: { ...process.env as Record<string, string>, ...resolvedEnv },
            });
            // Health check passed — prerequisite already satisfied
            entry.health_check_result = 'passed';
            entry.command_result = 'skipped';
            entry.duration_ms = Date.now() - startTime;
            entries.push(entry);
            skipped++;
            continue;
          } catch {
            // Health check failed — need to run setup command
            entry.health_check_result = 'failed';
          }
        }

        // Step 2: Run the setup command
        if (prereq.run_as_background) {
          // Background command: spawn detached, poll health_check
          const child = spawn('sh', ['-c', prereq.command], {
            cwd: EFFECTIVE_CWD,
            detached: true,
            stdio: 'ignore',
            env: { ...process.env, ...resolvedEnv },
          });
          child.unref();

          // Poll health check if available
          if (prereq.health_check) {
            const pollStart = Date.now();
            const pollInterval = 2000; // 2 seconds
            let ready = false;

            while (Date.now() - pollStart < prereq.timeout_ms) {
              await new Promise(resolve => setTimeout(resolve, pollInterval));
              try {
                execFileSync('sh', ['-c', prereq.health_check], {
                  cwd: EFFECTIVE_CWD,
                  timeout: prereq.health_check_timeout_ms,
                  stdio: 'pipe',
                  encoding: 'utf8',
                  env: { ...process.env as Record<string, string>, ...resolvedEnv },
                });
                ready = true;
                break;
              } catch {
                // Not ready yet, keep polling
              }
            }

            if (!ready) {
              entry.command_result = 'failed';
              entry.error = `Background command started but health check did not pass within ${prereq.timeout_ms}ms`;
              entry.duration_ms = Date.now() - startTime;
              entries.push(entry);
              failed++;
              return { success: false, total: prerequisites.length, passed, failed, skipped, entries, message: `Prerequisite failed: ${prereq.description} — ${entry.error}` };
            }
          } else {
            // No health check for background command — wait a brief moment
            await new Promise(resolve => setTimeout(resolve, 2000));
          }

          entry.command_result = 'passed';
        } else {
          // Foreground command: run with stall detection (kills if no output for 120s)
          const result = await runWithStallDetection(prereq.command, {
            cwd: EFFECTIVE_CWD,
            timeoutMs: prereq.timeout_ms,
            stallMs: 120_000,
            env: { ...process.env as Record<string, string>, ...resolvedEnv },
          });

          if (!result.success) {
            const errorMsg = result.error ?? 'Unknown error';
            entry.command_result = 'failed';
            entry.error = errorMsg.length > 500 ? errorMsg.slice(0, 500) + '...' : errorMsg;
            entry.duration_ms = Date.now() - startTime;
            entries.push(entry);
            failed++;
            return { success: false, total: prerequisites.length, passed, failed, skipped, entries, message: `Prerequisite failed: ${prereq.description} — ${entry.error}` };
          }

          entry.command_result = 'passed';

          // Step 3: Verify via health check if available
          if (prereq.health_check) {
            try {
              execFileSync('sh', ['-c', prereq.health_check], {
                cwd: EFFECTIVE_CWD,
                timeout: prereq.health_check_timeout_ms,
                stdio: 'pipe',
                encoding: 'utf8',
                env: { ...process.env as Record<string, string>, ...resolvedEnv },
              });
            } catch {
              entry.command_result = 'failed';
              entry.error = 'Command succeeded but health check verification failed after execution';
              entry.duration_ms = Date.now() - startTime;
              entries.push(entry);
              failed++;
              return { success: false, total: prerequisites.length, passed, failed, skipped, entries, message: `Prerequisite failed: ${prereq.description} — ${entry.error}` };
            }
          }
        }

        entry.duration_ms = Date.now() - startTime;
        entries.push(entry);
        passed++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        entry.command_result = 'failed';
        entry.error = message.length > 500 ? message.slice(0, 500) + '...' : message;
        entry.duration_ms = Date.now() - startTime;
        entries.push(entry);
        failed++;
        return { success: false, total: prerequisites.length, passed, failed, skipped, entries, message: `Prerequisite failed: ${prereq.description}` };
      }
    }

    return {
      success: true,
      total: prerequisites.length,
      passed,
      failed,
      skipped,
      entries,
      message: `All ${prerequisites.length} prerequisite(s) satisfied (${passed} executed, ${skipped} skipped via health check)`,
    };
  } finally {
    db.close();
  }
}

/**
 * Launch Playwright tests in headed auto-play mode.
 * Runs tests in a visible browser at configurable speed via DEMO_SLOW_MO env var.
 * Validates prerequisites, spawns a detached process, and monitors for early crashes.
 */
async function runDemo(args: RunDemoArgs): Promise<RunDemoResult> {
  const { project, slow_mo, base_url, test_file } = args;
  let effectiveTestFile = test_file;

  // Dedup: block duplicate simultaneous runs for the same scenario
  if (args.scenario_id) {
    for (const [existingPid, entry] of demoRuns) {
      if (entry.scenario_id === args.scenario_id && entry.status === 'running') {
        return {
          success: false,
          project,
          message: `Demo scenario "${args.scenario_id}" is already running (pid: ${existingPid}). Use check_demo_result to poll it, or stop_demo to cancel.`,
          pid: existingPid,
        };
      }
    }
  }

  // ── Spawned-session remote enforcement ──
  // Spawned agents (non-interactive sessions) MUST use remote Fly.io execution
  // UNLESS the CTO approved a demo_local bypass request for their task.
  const isSpawnedSession = process.env.CLAUDE_SPAWNED_SESSION === 'true';
  let hasLocalBypassApproval = false;
  if (isSpawnedSession) {
    // Check if CTO approved a demo_local bypass for this agent's task
    try {
      const bypassDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'bypass-requests.db');
      if (fs.existsSync(bypassDbPath)) {
        const bypassDb = new Database(bypassDbPath, { readonly: true });
        try {
          const approval = bypassDb.prepare(
            "SELECT id FROM bypass_requests WHERE category = 'demo_local' AND status = 'approved' AND created_at > datetime('now', '-1 hour') LIMIT 1"
          ).get();
          if (approval) hasLocalBypassApproval = true;
        } finally { bypassDb.close(); }
      }
    } catch { /* non-fatal — fail-closed (no approval) */ }

    if (!hasLocalBypassApproval) {
      const flyConfig = getFlyConfigFromServices();
      const flyAvailableForEnforcement = flyConfig !== null && flyConfig.enabled !== false && !!flyConfig.appName && !!flyConfig.apiToken;
      if (flyAvailableForEnforcement) {
        // Force remote execution — override whatever the caller passed
        args.remote = true;
      } else {
        // Fly.io not configured — fail-closed, spawned agents cannot run local demos
        return {
          success: false,
          project,
          message: 'Spawned agents are not allowed to run demos locally. Fly.io remote execution is required but not configured. ' +
            'Configure Fly.io via /setup-fly, or ask the CTO to run this demo from the live dashboard or an interactive session.',
        };
      }
    }
    // If hasLocalBypassApproval: respect the agent's remote: false (CTO approved local execution)
  }

  // All demos run headed with video recording. The headless parameter is
  // deprecated — force headed mode regardless of what the caller passed.
  args.headless = false;
  if (args.skip_recording === undefined) {
    args.skip_recording = false; // always record
  }

  // When remote: true + Fly configured, skip ALL local setup — the remote machine
  // handles its own clone, install, prerequisites, dev server, and test execution.
  const skipLocalSetup = args.remote === true && (() => {
    const flyConfig = getFlyConfigFromServices();
    return flyConfig !== null && flyConfig.enabled !== false && !!flyConfig.appName && !!flyConfig.apiToken;
  })();

  const webPort = process.env.PLAYWRIGHT_WEB_PORT || '3000';
  const devServerUrl = base_url || `http://localhost:${webPort}`;
  let devServer: { ready: boolean; message: string } = { ready: false, message: 'Skipped — remote execution' };
  let preflight: ReturnType<typeof validatePrerequisites> = { ok: true, errors: [], warnings: [] };

  if (!skipLocalSetup) {
    // Pre-flight validation (fast credential check, no I/O)
    preflight = validatePrerequisites();
    if (!preflight.ok) {
      return {
        success: false,
        project,
        message: `Environment validation failed:\n${preflight.errors.map(e => `  - ${e}`).join('\n')}`,
        context: `PROJECT_DIR=${PROJECT_DIR}, EFFECTIVE_CWD=${EFFECTIVE_CWD}`,
      };
    }

    // Worktree freshness gate — auto-sync or block stale demos (before prerequisites so
    // prerequisites run against up-to-date code)
    const freshness = checkAndSyncWorktree();
    if (!freshness.fresh) {
      return {
        success: false,
        project,
        message: `Worktree stale: ${freshness.message}`,
        context: `PROJECT_DIR=${PROJECT_DIR}, EFFECTIVE_CWD=${EFFECTIVE_CWD}`,
      };
    }

    // Build artifact verification — detect stale compiled code before running prerequisites
    const distWarnings = verifyDistArtifacts();
    if (distWarnings.length > 0) {
      return {
        success: false,
        project,
        message: `Build artifact verification failed:\n${distWarnings.map(w => `  - ${w}`).join('\n')}\nRebuild the affected artifacts before running the demo.`,
        context: `PROJECT_DIR=${PROJECT_DIR}, EFFECTIVE_CWD=${EFFECTIVE_CWD}`,
      };
    }

    // Execute registered prerequisites — this starts the dev server if registered as a background prereq
    const prereqResult = await executePrerequisites({
      scenario_id: args.scenario_id,
      base_url: devServerUrl,
    });
    if (!prereqResult.success) {
      return {
        success: false,
        project,
        message: `Demo prerequisites failed: ${prereqResult.message}. Run preflight_check to diagnose. Do NOT bypass by running Playwright directly.`,
        context: `PROJECT_DIR=${PROJECT_DIR}, EFFECTIVE_CWD=${EFFECTIVE_CWD}`,
      };
    }

    // Verify dev server is healthy (fallback auto-start if no prerequisite handled it)
    devServer = await ensureDevServer(devServerUrl);
    if (!devServer.ready) {
      return {
        success: false,
        project,
        message: `Dev server not ready after prerequisites: ${devServer.message}. Register: register_prerequisite({ command: "pnpm dev", scope: "global", run_as_background: true, health_check: "curl -sf http://localhost:\${PORT:-3000}" }). Use \${PORT:-3000} for worktree compatibility. Do NOT manually call secret_dev_server_start — run_demo handles dev server lifecycle automatically.`,
        context: `PROJECT_DIR=${PROJECT_DIR}, EFFECTIVE_CWD=${EFFECTIVE_CWD}`,
      };
    }
  }
  const effectiveBaseUrl = devServerUrl;

  // Display lock guard for headed demos — serialize to prevent window capture conflicts.
  // When headless=false AND running locally, require the caller to hold the display lock.
  // Skip when remote=true — Fly.io uses Xvfb, not the local display.
  let displayLockAutoAcquired = false;
  if (!args.headless && args.remote !== true) {
    try {
      const displayLockMod = await loadDisplayLock();
      if (displayLockMod) {
        const callerAgentId = getCallerAgentId();
        const callerQueueId = getCallerQueueId();
        const lockStatus = displayLockMod.getDisplayLockStatus();
        const holderAgentId = lockStatus.holder ? (lockStatus.holder as Record<string, unknown>)['agent_id'] as string : null;
        const callerIsHolder = lockStatus.locked && holderAgentId === callerAgentId;

        if (!callerIsHolder) {
          // Attempt to acquire
          const acquireResult = displayLockMod.acquireDisplayLock(
            callerAgentId,
            callerQueueId,
            `run_demo: ${args.scenario_id ?? project}`,
            { ttlMinutes: 15 },
          );
          if (!acquireResult.acquired) {
            return {
              success: false,
              project,
              message: `Display lock held by agent "${holderAgentId ?? 'unknown'}". Call acquire_display_lock first and wait for your turn before running a headed demo.`,
            };
          }
          displayLockAutoAcquired = true;
        }
      }
    } catch {
      // Non-fatal — if display-lock module errors, allow demo to proceed
    }
  }

  // Auth file freshness gate — prevent burning a full demo run on stale auth
  if (pwConfig.authFiles.length > 0 && pwConfig.primaryAuthFile) {
    const primaryFile = path.join(PROJECT_DIR, pwConfig.primaryAuthFile);
    if (fs.existsSync(primaryFile)) {
      const ageMs = Date.now() - fs.statSync(primaryFile).mtimeMs;
      if (ageMs > 24 * 60 * 60 * 1000) {
        return {
          success: false,
          project,
          message: `Auth state file is ${(ageMs / 3600000).toFixed(1)}h old (>24h). Run mcp__playwright__run_auth_setup to refresh.`,
        };
      }
      // Cookie expiry check
      try {
        const state = JSON.parse(fs.readFileSync(primaryFile, 'utf-8'));
        const now = Date.now() / 1000;
        const expiredCookies = (state.cookies || []).filter((c: { expires?: number }) => c.expires && c.expires > 0 && c.expires < now);
        if (expiredCookies.length > 0) {
          return {
            success: false,
            project,
            message: `Auth cookies are expired (${expiredCookies.length} expired cookie(s)). Run mcp__playwright__run_auth_setup to refresh.`,
          };
        }
      } catch { /* non-fatal — file may not be valid JSON storage state */ }
    }
  }

  // Look up scenario env_vars and test_file if scenario_id is provided
  let scenarioEnvVars: Record<string, string> | undefined;
  if (args.scenario_id) {
    try {
      const feedbackDbPath = getUserFeedbackDbPath();
      if (fs.existsSync(feedbackDbPath)) {
        const feedbackDb = new Database(feedbackDbPath, { readonly: true });
        try {
          const row = feedbackDb.prepare('SELECT env_vars, test_file, telemetry FROM demo_scenarios WHERE id = ?').get(args.scenario_id) as { env_vars: string | null; test_file: string | null; telemetry: number | null } | undefined;
          if (row?.env_vars) {
            try { scenarioEnvVars = JSON.parse(row.env_vars); } catch { /* invalid JSON */ }
          }
          // Auto-resolve test_file from scenario when not explicitly provided
          if (!effectiveTestFile && row?.test_file) {
            const dbTestFile = row.test_file;
            if (!dbTestFile.startsWith('/') && !dbTestFile.includes('..')) {
              effectiveTestFile = dbTestFile;
            }
          }
        } catch { /* env_vars/test_file column may not exist yet */ }
        feedbackDb.close();
      }
    } catch { /* non-fatal */ }
  }

  // Resolve any op:// references in scenario env_vars before merging
  if (scenarioEnvVars) {
    const { resolved: resolvedScenarioEnv, failedKeys: scenarioFailedKeys, failureDetails: scenarioFailureDetails } = resolveOpReferencesStrict(scenarioEnvVars);
    if (scenarioFailedKeys.length > 0) {
      const details = scenarioFailedKeys.map(k => `  ${k}: ${scenarioFailureDetails[k] || 'unknown error'}`).join('\n');
      return {
        success: false,
        project,
        message: `Credential resolution failed for scenario env vars:\n${details}\nThese op:// references could not be resolved by the MCP server.`,
      };
    }
    scenarioEnvVars = resolvedScenarioEnv;
  }

  // Validate extra_env independently — scenario env_vars are trusted (DB-sourced,
  // product-manager authored) and should not be subject to the blocklist or key limit.
  if (args.extra_env && Object.keys(args.extra_env).length > 0) {
    const validationError = validateExtraEnv(args.extra_env);
    if (validationError) {
      return { success: false, project, message: validationError };
    }
  }

  // Merge env_vars: scenario env_vars as base, explicit extra_env overrides
  const mergedExtraEnv = { ...scenarioEnvVars, ...args.extra_env };

  // Fix 4: Generate progress file path for real-time progress reporting
  const progressId = crypto.randomBytes(4).toString('hex');
  const progressFilePath = path.join(PROJECT_DIR, '.claude', 'state', `demo-progress-${progressId}.jsonl`);

  // Generate unique run ID for telemetry correlation (always, even without telemetry mode)
  const scenarioSlug = (args.scenario_id || 'adhoc').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 30);
  const runId = `dr-${scenarioSlug}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

  // Resolve telemetry flag: explicit run_demo param overrides scenario-level setting
  let scenarioTelemetry = false;
  if (args.scenario_id) {
    try {
      const feedbackDbPath = getUserFeedbackDbPath();
      if (fs.existsSync(feedbackDbPath)) {
        const tmpDb = new Database(feedbackDbPath, { readonly: true });
        try {
          const tRow = tmpDb.prepare('SELECT telemetry FROM demo_scenarios WHERE id = ?').get(args.scenario_id) as { telemetry: number | null } | undefined;
          scenarioTelemetry = tRow?.telemetry === 1;
        } catch { /* column may not exist yet */ }
        tmpDb.close();
      }
    } catch { /* non-fatal */ }
  }
  const telemetryEnabled = args.telemetry || scenarioTelemetry;

  // Prepare telemetry directory when enabled
  let telemetryDir: string | undefined;
  if (telemetryEnabled) {
    telemetryDir = path.join(PROJECT_DIR, '.claude', 'recordings', 'demos', args.scenario_id || 'adhoc', 'telemetry');
    fs.mkdirSync(telemetryDir, { recursive: true });
  }

  let env: Record<string, string>;
  try {
    env = buildDemoEnv({
      slow_mo,
      headless: args.headless,
      base_url: effectiveBaseUrl,
      trace: args.trace,
      extra_env: Object.keys(mergedExtraEnv).length > 0 ? mergedExtraEnv : undefined,
      progress_file: progressFilePath,
      run_id: runId,
      telemetry: telemetryEnabled,
      telemetry_dir: telemetryDir,
      dev_server_ready: devServer.ready,
    });
  } catch (err) {
    return {
      success: false,
      project,
      message: `Credential resolution failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // ── Remote/Steel execution routing ──
  // All dynamic imports use .js extension for ESM. Both modules may not exist
  // in all environments — all errors fall through to local execution.
  let remoteRoutingWarning = '';
  let executionTargetResult: { target: 'local' | 'remote' | 'steel'; reason: string } | null = null;
  let steelOnlySessionId: string | undefined; // Set when stealth-only Steel session created (for cleanup in local path)
  let scenarioComputeSize: 'standard' | 'large' | undefined;
  let computeSizeUsed: 'standard' | 'large' = 'standard';
  remoteRoutingBlock: {
    // Resolve Fly.io config (may be absent — Steel-only scenarios don't need it)
    const flyConfig = getFlyConfigFromServices();
    const flyAvailable = !!(flyConfig && flyConfig.enabled !== false && flyConfig.appName && flyConfig.apiToken);
    let resolvedFlyToken = '';
    if (flyAvailable) {
      const { resolved: flyResolved, failedKeys: flyFailedKeys } = resolveOpReferencesStrict({ FLY_API_TOKEN: flyConfig!.apiToken });
      if (flyFailedKeys.length === 0) resolvedFlyToken = flyResolved['FLY_API_TOKEN'];
    }

    // Resolve Steel config (may be absent — non-stealth scenarios don't need it)
    const steelSection = getSteelConfigFromServices();
    const steelAvailable = !!(steelSection && steelSection.enabled);
    let resolvedSteelKey = '';
    if (steelAvailable) {
      const { resolved: steelResolved, failedKeys: steelFailedKeys } = resolveOpReferencesStrict({ STEEL_API_KEY: steelSection!.apiKey });
      if (steelFailedKeys.length === 0) resolvedSteelKey = steelResolved['STEEL_API_KEY'];
    }

    // If neither Fly.io nor Steel is configured, skip remote routing entirely
    if (!flyAvailable && !resolvedFlyToken && !steelAvailable) {
      executionTargetResult = { target: 'local', reason: 'Neither Fly.io nor Steel is configured' };
      break remoteRoutingBlock;
    }

    let scenarioHeaded = false;
    let usesChromeBridge = false;
    let remoteEligible: boolean | undefined;
    let stealthRequired = false;
    let dualInstance = false;
    if (args.scenario_id) {
      try {
        const feedbackDbPath = getUserFeedbackDbPath();
        if (fs.existsSync(feedbackDbPath)) {
          const scenarioDb = new Database(feedbackDbPath, { readonly: true });
          try {
            const scenarioRow = scenarioDb.prepare('SELECT headed, remote_eligible, stealth_required, dual_instance, compute_size FROM demo_scenarios WHERE id = ?')
              .get(args.scenario_id) as { headed: number | null; remote_eligible: number | null; stealth_required: number | null; dual_instance: number | null; compute_size: string | null } | undefined;
            if (scenarioRow?.headed === 1) scenarioHeaded = true;
            if (scenarioRow?.remote_eligible === 0) remoteEligible = false;
            else if (scenarioRow?.remote_eligible === 1) remoteEligible = true;
            if (scenarioRow?.stealth_required === 1) stealthRequired = true;
            if (scenarioRow?.dual_instance === 1) dualInstance = true;
            if (scenarioRow?.compute_size === 'large') scenarioComputeSize = 'large';
            else if (scenarioRow?.compute_size === 'standard') scenarioComputeSize = 'standard';
          } catch { /* column may not exist */ }
          scenarioDb.close();
        }
      } catch { /* non-fatal */ }
    }

    if (effectiveTestFile) {
      const chromeBridgePatterns = [/\bext-[^/]+\.demo\.ts$/, /\bplatform[^/]*\.demo\.ts$/i, /\/extension\//i, /\/platform-fixtures/i];
      usesChromeBridge = chromeBridgePatterns.some(p => p.test(effectiveTestFile!));
    }

    let displayLockContended = false;
    try {
      const displayLockMod = await loadDisplayLock();
      if (displayLockMod) {
        const lockStatus = displayLockMod.getDisplayLockStatus();
        const callerAgentId = getCallerAgentId();
        const holderAgentId = lockStatus.holder ? (lockStatus.holder as Record<string, unknown>)['agent_id'] as string : null;
        displayLockContended = lockStatus.locked && holderAgentId !== callerAgentId;
      }
    } catch { /* non-fatal */ }

    // Per-scenario compute_size: 'large' = 8192MB, 'standard'/null = use global per-mode default
    computeSizeUsed = scenarioComputeSize === 'large' ? 'large' : 'standard';

    try {
      const [executionTargetMod, flyRunnerMod] = await Promise.all([
        import('./execution-target.js'),
        import('./fly-runner.js'),
      ]);
      const { resolveExecutionTarget, checkSteelHealth: checkSteelHealthFn } = executionTargetMod;
      const { listActiveMachines, spawnRemoteMachine, isMachineAlive } = flyRunnerMod;

      // Read per-mode RAM config (state file, always writable, no sync needed)
      const ramConfig = readFlyMachineConfig();
      const globalRam = args.headless ? ramConfig.machineRamHeadless : ramConfig.machineRamHeaded;
      // Per-scenario compute_size override: 'large' = 8192MB, otherwise use global default
      const COMPUTE_SIZE_RAM = { standard: 4096, large: 8192 } as const;
      const effectiveRam = scenarioComputeSize === 'large' ? COMPUTE_SIZE_RAM.large : globalRam;

      const machineConfig = flyAvailable ? {
        apiToken: resolvedFlyToken,
        appName: flyConfig!.appName,
        region: flyConfig!.region || 'iad',
        machineSize: flyConfig!.machineSize || 'shared-cpu-2x',
        machineRam: effectiveRam,
        maxConcurrentMachines: flyConfig!.maxConcurrentMachines || 3,
        projectImageEnabled: flyConfig!.projectImageEnabled,
      } : null;

      let activeMachineCount = 0;
      if (machineConfig) {
        try {
          const machines = await listActiveMachines(machineConfig);
          activeMachineCount = machines.length;
        } catch { /* non-fatal */ }
      }

      // Steel health and capacity checks (only when configured)
      let steelHealthy = false;
      let activeSteelSessionCount = 0;
      if (steelAvailable && resolvedSteelKey) {
        steelHealthy = await checkSteelHealthFn(resolvedSteelKey, 5000);
        if (steelHealthy) {
          try {
            const { listActiveSteelSessions } = await import('./steel-runner.js');
            const sessions = await listActiveSteelSessions({ apiKey: resolvedSteelKey, orgId: steelSection!.orgId });
            activeSteelSessionCount = sessions.length;
          } catch { /* non-fatal */ }
        }
      }

      const target = resolveExecutionTarget({
        headless: args.headless,
        flyConfigured: flyAvailable && !!resolvedFlyToken,
        flyHealthy: flyAvailable && !!resolvedFlyToken,
        displayLockContended,
        scenarioHeaded,
        usesChromeBridge,
        remoteEligible,
        explicitRemote: args.remote,
        activeMachineCount,
        maxConcurrentMachines: flyConfig?.maxConcurrentMachines || 3,
        stealthRequired,
        dualInstance,
        steelConfigured: steelAvailable && !!resolvedSteelKey,
        steelHealthy,
        activeSteelSessionCount,
        maxConcurrentSteelSessions: steelSection?.maxConcurrentSessions ?? 2,
      });

      // ── Fail-closed: routing error (e.g., stealth required but Steel unavailable) ──
      if (target.error) {
        return {
          success: false,
          project,
          message: `Routing error: ${target.reason}`,
          execution_target: target.target,
          execution_target_reason: target.reason,
        };
      }

      // ── Post-routing spawned-agent local guard ──
      // If the resolver routed to local for a spawned agent (despite args.remote=true),
      // block unless CTO approved a demo_local bypass. This catches cases where
      // remote_eligible=false or usesChromeBridge forced local routing.
      if (isSpawnedSession && target.target === 'local' && !hasLocalBypassApproval) {
        return {
          success: false,
          project,
          message: `LOCAL DEMO BLOCKED: Execution routed to local (${target.reason}). ` +
            `Spawned agents cannot run demos locally without CTO approval. ` +
            `File a bypass request: submit_bypass_request({ task_type: 'todo', task_id: YOUR_TASK_ID, ` +
            `category: 'demo_local', summary: 'Need local execution: ${target.reason}' }) then summarize_work and exit.`,
          execution_target: 'local',
          execution_target_reason: target.reason,
        };
      }

      // ── STEEL EXECUTION PATH ──
      if (target.target === 'steel') {
        try {
          const { createSteelSession } = await import('./steel-runner.js');
          const steelConfig = {
            apiKey: resolvedSteelKey,
            orgId: steelSection!.orgId,
            defaultTimeout: steelSection!.defaultTimeout ?? 300000,
            extensionId: steelSection!.extensionId,
            proxyConfig: steelSection!.proxyConfig ? {
              enabled: steelSection!.proxyConfig.enabled,
              country: steelSection!.proxyConfig.country,
            } : undefined,
          };

          const session = await createSteelSession(steelConfig, {
            useProxy: steelConfig.proxyConfig?.enabled,
            solveCaptcha: true,
            timeout: args.timeout ?? steelConfig.defaultTimeout,
          });

          if (dualInstance && machineConfig) {
            // Dual-instance: also spawn Fly.io machine with Steel CDP URL as env var
            const remoteEnv: Record<string, string> = {};
            if (scenarioEnvVars) Object.assign(remoteEnv, scenarioEnvVars);
            if (args.extra_env) Object.assign(remoteEnv, args.extra_env);

            // Profile-scoped secret resolution: only resolve secrets needed by this scenario
            const dualSecrets = resolveProfileScopedSecrets(args.scenario_id, true /* stealth */);
            Object.assign(remoteEnv, dualSecrets.resolved);
            if (dualSecrets.warnings.length > 0) {
              process.stderr.write(`[steel-runner] Skipped secrets: ${dualSecrets.warnings.join('; ')}\n`);
            }
            if (process.env.GITHUB_TOKEN) remoteEnv.GIT_AUTH_TOKEN = process.env.GITHUB_TOKEN;
            if (!remoteEnv.GIT_AUTH_TOKEN && remoteEnv.GITHUB_TOKEN) remoteEnv.GIT_AUTH_TOKEN = remoteEnv.GITHUB_TOKEN;

            // Inject Steel env vars for the test code on Fly.io
            remoteEnv.STEEL_CDP_URL = session.cdpUrl;
            remoteEnv.STEEL_SESSION_ID = session.sessionId;
            remoteEnv.STEEL_DUAL_INSTANCE = '1';

            let gitRemote = '';
            let gitRef = 'main';
            try {
              gitRemote = execSync('git remote get-url origin', { cwd: EFFECTIVE_CWD, encoding: 'utf8', timeout: 5000 }).trim();
              if (gitRemote.startsWith('git@github.com:')) gitRemote = gitRemote.replace('git@github.com:', 'https://github.com/');
              gitRef = execSync('git rev-parse --abbrev-ref HEAD', { cwd: EFFECTIVE_CWD, encoding: 'utf8', timeout: 5000 }).trim();
              if (gitRef === 'HEAD') gitRef = execSync('git rev-parse HEAD', { cwd: EFFECTIVE_CWD, encoding: 'utf8', timeout: 5000 }).trim();
            } catch { /* non-fatal */ }

            const handle = await spawnRemoteMachine(machineConfig, {
              gitRemote,
              gitRef,
              testFile: effectiveTestFile || '',
              env: remoteEnv,
              timeout: args.timeout ?? 1800000,
              slowMo: args.slow_mo ?? 0,
              headless: args.headless,
              scenarioId: args.scenario_id,
              runId,
              servicesJsonPath: path.join(PROJECT_DIR, '.claude', 'config', 'services.json'),
            });

            // Synthetic PID in the Steel range (-1_000_001 to -2_000_000)
            const syntheticPid = -(Math.abs(hashCode(session.sessionId)) % 1_000_000 + 1_000_001);
            const steelDemoState: DemoRunState = {
              pid: syntheticPid,
              project,
              test_file: effectiveTestFile,
              started_at: new Date().toISOString(),
              status: 'running',
              scenario_id: args.scenario_id,
              remote: true,
              fly_machine_id: handle.machineId,
              fly_app_name: handle.appName,
              steel_session_id: session.sessionId,
              dual_instance: true,
              execution_target: 'steel',
              compute_size_used: computeSizeUsed,
            };
            demoRuns.set(syntheticPid, steelDemoState);
            persistDemoRuns();

            return {
              success: true,
              project,
              message: `Dual-instance demo started: Steel session ${session.sessionId} + Fly.io machine ${handle.machineId}. Use check_demo_result with pid=${syntheticPid} to poll.`,
              pid: syntheticPid,
              test_file: effectiveTestFile,
              remote: true,
              execution_target: 'steel',
              execution_target_reason: target.reason,
              fly_machine_id: handle.machineId,
              steel_session_id: session.sessionId,
            };
          } else {
            // Stealth-only: inject Steel env vars and fall through to the
            // local Playwright execution path below remoteRoutingBlock.
            // The local path will spawn Playwright with these env vars,
            // and the test code connects to the Steel browser via STEEL_CDP_URL.
            if (!args.extra_env) args.extra_env = {};
            args.extra_env.STEEL_CDP_URL = session.cdpUrl;
            args.extra_env.STEEL_SESSION_ID = session.sessionId;

            // Store the Steel session ID so cleanup paths can release it
            steelOnlySessionId = session.sessionId;
            // Fall through to local execution path
            executionTargetResult = { target: 'steel', reason: 'Steel-only scenario: local Playwright connecting to Steel cloud browser via CDP' };
            break remoteRoutingBlock;
          }
        } catch (steelErr) {
          // Stealth scenarios must NOT fall back — fail-closed
          return {
            success: false,
            project,
            message: `Steel execution failed: ${steelErr instanceof Error ? steelErr.message : String(steelErr)}`,
            execution_target: 'steel' as const,
            execution_target_reason: target.reason,
          };
        }
      }

      if (target.target !== 'remote') {
        executionTargetResult = { target: target.target, reason: target.reason };
        break remoteRoutingBlock;
      }
      // Fly.io is guaranteed available when target === 'remote'
      if (!machineConfig) {
        executionTargetResult = { target: 'local', reason: 'Fly.io machine config unavailable despite remote routing decision' };
        break remoteRoutingBlock;
      }

      // ── REMOTE EXECUTION PATH (Fly.io) ──
      const remoteEnv: Record<string, string> = {};
      if (scenarioEnvVars) Object.assign(remoteEnv, scenarioEnvVars);
      if (args.extra_env) Object.assign(remoteEnv, args.extra_env);

      // Profile-scoped secret resolution: resolve only secrets needed by this scenario.
      // Individual failures are non-fatal — only the broken key is skipped, not all secrets.
      const remoteSecrets = resolveProfileScopedSecrets(args.scenario_id, stealthRequired);
      Object.assign(remoteEnv, remoteSecrets.resolved);
      if (remoteSecrets.warnings.length > 0) {
        process.stderr.write(`[fly-runner] Skipped secrets for scenario ${args.scenario_id}: ${remoteSecrets.warnings.join('; ')}\n`);
      }

      if (process.env.GITHUB_TOKEN) remoteEnv.GIT_AUTH_TOKEN = process.env.GITHUB_TOKEN;
      // Also map GITHUB_TOKEN from resolved secrets.local to GIT_AUTH_TOKEN
      // (remote-runner.sh expects GIT_AUTH_TOKEN for git credential helper)
      if (!remoteEnv.GIT_AUTH_TOKEN && remoteEnv.GITHUB_TOKEN) {
        remoteEnv.GIT_AUTH_TOKEN = remoteEnv.GITHUB_TOKEN;
      }

      let gitRemote = '';
      let gitRef = 'main';
      try {
        gitRemote = execSync('git remote get-url origin', { cwd: EFFECTIVE_CWD, encoding: 'utf8', timeout: 5000 }).trim();
        // Convert SSH URLs to HTTPS for container compatibility (no SSH keys in Docker)
        if (gitRemote.startsWith('git@github.com:')) {
          gitRemote = gitRemote.replace('git@github.com:', 'https://github.com/');
        }
        gitRef = execSync('git rev-parse --abbrev-ref HEAD', { cwd: EFFECTIVE_CWD, encoding: 'utf8', timeout: 5000 }).trim();
        if (gitRef === 'HEAD') gitRef = execSync('git rev-parse HEAD', { cwd: EFFECTIVE_CWD, encoding: 'utf8', timeout: 5000 }).trim();
      } catch { /* non-fatal */ }

      // Ensure the branch exists on the remote — worktree branches are local-only until pushed
      if (gitRef && gitRef !== 'HEAD' && gitRef !== 'main' && gitRef !== 'preview') {
        try {
          const lsRemote = execSync(`git ls-remote --heads origin ${gitRef}`, { cwd: EFFECTIVE_CWD, encoding: 'utf8', timeout: 10000 }).trim();
          if (!lsRemote) {
            // Branch doesn't exist on remote — push it
            process.stderr.write(`[fly-runner] Branch '${gitRef}' not on remote — pushing before remote execution\n`);
            execSync(`git push -u origin HEAD:${gitRef}`, { cwd: EFFECTIVE_CWD, encoding: 'utf8', timeout: 30000, stdio: 'pipe' });
          }
        } catch (pushErr) {
          process.stderr.write(`[fly-runner] Branch push failed: ${pushErr instanceof Error ? pushErr.message : String(pushErr)}\n`);
          // Fall back to base branch if push fails
          try {
            const baseBranch = execSync('git ls-remote --heads origin preview', { cwd: EFFECTIVE_CWD, encoding: 'utf8', timeout: 5000 }).trim()
              ? 'preview' : 'main';
            process.stderr.write(`[fly-runner] Falling back to base branch: ${baseBranch}\n`);
            gitRef = baseBranch;
          } catch { /* keep original gitRef */ }
        }
      }

      let devServerCmd: string | undefined;
      let devServerPort: number | undefined;
      let devServerHealthCheck: string | undefined;
      try {
        const servicesPath = path.join(PROJECT_DIR, '.claude', 'config', 'services.json');
        if (fs.existsSync(servicesPath)) {
          const services = JSON.parse(fs.readFileSync(servicesPath, 'utf-8'));
          if (services.devServices) {
            const firstService = Object.values(services.devServices)[0] as { filter?: string; command?: string; port?: number } | undefined;
            if (firstService) {
              devServerCmd = firstService.filter
                ? `pnpm --filter ${firstService.filter} ${firstService.command || 'dev'}`
                : `pnpm ${firstService.command || 'dev'}`;
              devServerPort = firstService.port || 3000;
              devServerHealthCheck = `curl -sf http://localhost:${devServerPort}`;
            }
          }
        }
      } catch { /* non-fatal */ }

      // Pass stall config to remote machine env
      if (args.stall_timeout_ms) {
        remoteEnv['GENTYR_STALL_TIMEOUT_S'] = String(Math.ceil(args.stall_timeout_ms / 1000));
      }
      remoteEnv['GENTYR_STALL_GRACE_S'] = '60';

      // Serialize prerequisites for remote execution
      try {
        const feedbackDbPath = getUserFeedbackDbPath();
        if (fs.existsSync(feedbackDbPath)) {
          const prereqDb = new Database(feedbackDbPath, { readonly: true });
          try {
            const tableExists = prereqDb.prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='demo_prerequisites'"
            ).get();

            if (tableExists) {
              let prereqPersonaId: string | undefined;
              if (args.scenario_id) {
                const scenRow = prereqDb.prepare('SELECT persona_id FROM demo_scenarios WHERE id = ?')
                  .get(args.scenario_id) as { persona_id: string } | undefined;
                prereqPersonaId = scenRow?.persona_id;
              }

              const conditions: string[] = ["scope = 'global'"];
              const params: string[] = [];
              if (prereqPersonaId) {
                conditions.push("(scope = 'persona' AND persona_id = ?)");
                params.push(prereqPersonaId);
              }
              if (args.scenario_id) {
                conditions.push("(scope = 'scenario' AND scenario_id = ?)");
                params.push(args.scenario_id);
              }

              const query = `SELECT id, command, description, timeout_ms, health_check, health_check_timeout_ms, scope, run_as_background, sort_order FROM demo_prerequisites WHERE enabled = 1 AND (${conditions.join(' OR ')}) ORDER BY CASE scope WHEN 'global' THEN 0 WHEN 'persona' THEN 1 WHEN 'scenario' THEN 2 END, sort_order ASC`;

              const prerequisites = prereqDb.prepare(query).all(...params) as Array<Record<string, unknown>>;

              if (prerequisites.length > 0) {
                remoteEnv['GENTYR_PREREQUISITES'] = JSON.stringify(prerequisites);
              }
            }
          } finally {
            prereqDb.close();
          }
        }
      } catch { /* non-fatal — prerequisites won't run remotely */ }

      // Check image freshness before remote spawn (non-blocking warning)
      let imageStalenessWarning = '';
      try {
        const metaPath = path.join(PROJECT_DIR, '.claude', 'state', 'fly-image-metadata.json');
        if (fs.existsSync(metaPath)) {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          const infraDirCandidates = [
            path.join(PROJECT_DIR, 'node_modules', 'gentyr', 'infra', 'fly-playwright'),
            path.join(PROJECT_DIR, 'infra', 'fly-playwright'),
          ];
          const infraDir = infraDirCandidates.find(d => fs.existsSync(d));
          if (infraDir) {
            const curDockerHash = crypto.createHash('sha256')
              .update(fs.readFileSync(path.join(infraDir, 'Dockerfile'))).digest('hex');
            const curRunnerHash = crypto.createHash('sha256')
              .update(fs.readFileSync(path.join(infraDir, 'remote-runner.sh'))).digest('hex');
            if (curDockerHash !== meta.dockerfileHash || curRunnerHash !== meta.remoteRunnerHash) {
              imageStalenessWarning = `WARNING: Fly.io image is stale (Dockerfile or remote-runner.sh changed since last deploy at ${meta.deployedAt}). Results may be unreliable. Run deploy_fly_image({ force: true }) to rebuild.`;
            }
          }
        }
      } catch { /* non-fatal, don't block the demo */ }

      const handle = await spawnRemoteMachine(machineConfig, {
        gitRemote,
        gitRef,
        testFile: effectiveTestFile || '',
        env: remoteEnv,
        timeout: args.timeout ?? 1800000,
        slowMo: args.slow_mo ?? 0,
        headless: args.headless,
        devServerCmd,
        devServerPort,
        devServerHealthCheck,
        buildCmd: undefined,
        scenarioId: args.scenario_id,
        runId,
        servicesJsonPath: path.join(PROJECT_DIR, '.claude', 'config', 'services.json'),
      });

      const syntheticPid = -(Math.abs(hashCode(handle.machineId)) % 1_000_000 + 1);
      const remoteDemoState: DemoRunState = {
        pid: syntheticPid,
        project,
        test_file: effectiveTestFile,
        started_at: new Date().toISOString(),
        status: 'running',
        scenario_id: args.scenario_id,
        remote: true,
        fly_machine_id: handle.machineId,
        fly_app_name: handle.appName,
        run_id: runId,
        compute_size_used: computeSizeUsed,
      };
      // Attach image staleness warning so check_demo_result can surface it
      if (imageStalenessWarning) {
        remoteDemoState.image_staleness_warning = imageStalenessWarning;
      }
      demoRuns.set(syntheticPid, remoteDemoState);
      persistDemoRuns();

      let lastRemoteProgressCount = 0;
      let lastRemoteProgressAt = Date.now();
      const REMOTE_STALL_GRACE_MS = 60_000;
      // Remote default is 5 minutes (not 45s like local) — pnpm install on cold machines
      // takes 2-4 minutes with no progress events between install_start and install_done.
      const REMOTE_STALL_TIMEOUT_MS = args.stall_timeout_ms ?? 300_000;

      const pollInterval = setInterval(async () => {
        try {
          const alive = await isMachineAlive(handle, machineConfig);
          if (!alive) {
            // Machine died — attempt last-chance artifact pull before marking unknown
            const deadEntry = demoRuns.get(syntheticPid);
            if (deadEntry && !deadEntry.artifacts_pulled) {
              try {
                const destDir = path.join(PROJECT_DIR, '.claude', 'state', `demo-remote-${handle.machineId}`);
                fs.mkdirSync(destDir, { recursive: true });
                const { pullRemoteArtifacts: pullArtifacts } = await import('./fly-runner.js');
                const pullResult = await pullArtifacts(handle, machineConfig, destDir);
                if (pullResult.errors.length > 0) {
                  process.stderr.write(`[fly-runner] Dead-machine pull errors: ${pullResult.errors.join('; ')}\n`);
                }
                deadEntry.artifacts_pulled = true;
                deadEntry.artifacts_dest_dir = destDir;
                // Try to read exit code from pulled artifacts
                const exitCodePath = path.join(destDir, 'exit-code');
                if (fs.existsSync(exitCodePath)) {
                  const code = parseInt(fs.readFileSync(exitCodePath, 'utf8').trim(), 10);
                  deadEntry.status = code === 0 ? 'passed' : 'failed';
                } else {
                  deadEntry.status = 'unknown';
                }
              } catch {
                // Machine already destroyed — can't pull. Mark unknown.
                if (deadEntry && deadEntry.status === 'running') {
                  deadEntry.status = 'unknown';
                }
              }
              persistDemoRuns();
            } else if (deadEntry && deadEntry.status === 'running') {
              deadEntry.status = 'unknown';
              persistDemoRuns();
            }
            clearInterval(pollInterval);
            return;
          }
        } catch { /* non-fatal */ }

        // ── Proactive artifact pull: check if artifacts are ready ──
        // The .artifacts-ready sentinel is written by remote-runner.sh AFTER all
        // artifacts have been copied and the exit code has been written. Checking
        // this instead of .exit-code avoids the race where artifacts haven't been
        // copied yet when the exit code appears.
        const currentEntry = demoRuns.get(syntheticPid);
        if (currentEntry && !currentEntry.artifacts_pulled) {
          try {
            const { execInMachine: execCmd, pullRemoteArtifacts: pullArtifacts, stopRemoteMachine: stopMachine } = await import('./fly-runner.js');
            // Primary: check .artifacts-ready sentinel (new remote-runner.sh)
            // Fallback: check .exit-code with delay (old remote-runner.sh without sentinel)
            let artifactsReady = false;
            try {
              await execCmd(handle, machineConfig, ['cat', '/app/.artifacts-ready'], 5_000);
              artifactsReady = true;
            } catch {
              // Sentinel not found — try .exit-code as backward-compat fallback
              try {
                const ecBuf = await execCmd(handle, machineConfig, ['cat', '/app/.exit-code'], 5_000);
                if (ecBuf.toString('utf8').trim() !== '') {
                  // Exit code exists but no sentinel — old Docker image. Wait 15s
                  // for cleanup to finish copying artifacts before pulling.
                  process.stderr.write('[fly-runner] .artifacts-ready not found, falling back to .exit-code with 15s delay\n');
                  await new Promise(r => setTimeout(r, 15_000));
                  artifactsReady = true;
                }
              } catch { /* neither file exists — demo still running */ }
            }
            if (artifactsReady) {
              // Read exit code
              let exitCodeStr = '1';
              try {
                const exitCodeBuf = await execCmd(handle, machineConfig, ['cat', '/app/.exit-code'], 5_000);
                exitCodeStr = exitCodeBuf.toString('utf8').trim() || '1';
              } catch { /* non-fatal, use default */ }

              // Demo finished — pull artifacts now while machine is still alive
              process.stderr.write(`[fly-runner] Artifacts ready (exit code: ${exitCodeStr}), pulling proactively\n`);

              const destDir = path.join(PROJECT_DIR, '.claude', 'state', `demo-remote-${handle.machineId}`);
              fs.mkdirSync(destDir, { recursive: true });

              let proactivePullErrors: string[] = [];
              try {
                const pullResult = await pullArtifacts(handle, machineConfig, destDir);
                proactivePullErrors = pullResult.errors;
                if (proactivePullErrors.length > 0) {
                  process.stderr.write(`[fly-runner] Proactive pull errors: ${proactivePullErrors.join('; ')}\n`);
                }
              } catch (pullErr) {
                process.stderr.write(`[fly-runner] Proactive artifact pull error: ${pullErr instanceof Error ? pullErr.message : String(pullErr)}\n`);
                proactivePullErrors.push(pullErr instanceof Error ? pullErr.message : String(pullErr));
              }

              // Mark artifacts as pulled on the DemoRunState
              const demoEntry = demoRuns.get(syntheticPid);
              if (demoEntry) {
                demoEntry.artifacts_pulled = true;
                demoEntry.artifacts_dest_dir = destDir;
                // Parse exit code to determine status
                const exitCode = parseInt(exitCodeStr, 10);
                demoEntry.status = exitCode === 0 ? 'passed' : 'failed';
                persistDemoRuns();
              }

              // Stop the machine — don't waste the remaining grace period
              try {
                await stopMachine(handle, machineConfig);
              } catch { /* non-fatal */ }

              clearInterval(pollInterval);
              return;
            }
          } catch {
            // Unexpected error in artifact readiness check — continue polling
          }
        }

        // Stall detection via progress polling
        if (REMOTE_STALL_TIMEOUT_MS > 0 && Date.now() - handle.startedAt >= REMOTE_STALL_GRACE_MS) {
          try {
            const { pollRemoteProgress: pollProgress } = await import('./fly-runner.js');
            const events = await pollProgress(handle, machineConfig);
            if (events.length > lastRemoteProgressCount) {
              lastRemoteProgressCount = events.length;
              lastRemoteProgressAt = Date.now();
            }

            const silenceMs = Date.now() - lastRemoteProgressAt;
            if (silenceMs >= REMOTE_STALL_TIMEOUT_MS) {
              process.stderr.write(`[fly-runner] Remote demo stalled: no progress for ${Math.round(silenceMs / 1000)}s\n`);
              const stallEntry = demoRuns.get(syntheticPid);
              if (stallEntry) {
                stallEntry.failure_summary = `Stalled: no progress for ${Math.round(REMOTE_STALL_TIMEOUT_MS / 1000)}s after ${Math.round(REMOTE_STALL_GRACE_MS / 1000)}s grace`;
                stallEntry.status = 'failed';
                persistDemoRuns();
              }
              try {
                const { stopRemoteMachine: stopMachine } = await import('./fly-runner.js');
                await stopMachine(handle, machineConfig);
              } catch {}
              clearInterval(pollInterval);
            }
          } catch {
            // API error — not a stall, skip
          }
        }
      }, 10_000);

      const remoteEntry = demoRuns.get(syntheticPid);
      if (remoteEntry) {
        (remoteEntry as DemoRunState & { _remotePollInterval?: ReturnType<typeof setInterval> })._remotePollInterval = pollInterval;
      }

      return {
        success: true,
        project,
        message: `Demo launched remotely on Fly.io machine ${handle.machineId} in ${handle.region}. Use check_demo_result with pid ${syntheticPid} to get results.`,
        pid: syntheticPid,
        slow_mo: args.slow_mo,
        test_file: effectiveTestFile,
        remote: true,
        execution_target: 'remote',
        execution_target_reason: target.reason,
        fly_machine_id: handle.machineId,
      };
    } catch (remoteErr) {
      const errMsg = remoteErr instanceof Error ? remoteErr.message : String(remoteErr);
      process.stderr.write(`[fly-runner] Remote execution failed: ${errMsg}\n`);

      // Detect image-not-found errors and add actionable guidance
      // Anchored to Fly-specific patterns to avoid false positives on unrelated "not found" errors
      const isImageError = /registry\.fly\.io|could not resolve image|docker image|manifest.*not found|image.*not found/i.test(errMsg);
      const imageFixHint = isImageError
        ? '. No Docker image is deployed to the Fly app. Fix: call deploy_fly_image() to build and push the image, then retry.'
        : '';

      // If the agent explicitly forced remote, surface the error — don't silently fall back
      if (args.remote === true) {
        return {
          success: false,
          project,
          message: `Remote execution failed: ${errMsg}${imageFixHint}`,
          test_file: effectiveTestFile,
          remote: true,
          execution_target: 'remote',
          execution_target_reason: 'Explicitly requested remote execution (remote: true)',
        } as RunDemoResult;
      }

      // Auto-routed: fall back to local but record a warning for check_demo_result to surface
      process.stderr.write(`[fly-runner] Falling back to local execution\n`);
      remoteRoutingWarning = `Remote execution attempted but failed (falling back to local): ${errMsg}${imageFixHint}`;
      executionTargetResult = { target: 'local', reason: `Auto-routed remote execution failed, falling back to local: ${errMsg}` };
    }
  }

  const cmdArgs = ['playwright', 'test', '--project', project];
  if (args.trace) {
    cmdArgs.push('--trace', 'on');
  }

  // Insert test_file as positional arg (after 'test', before '--project')
  if (effectiveTestFile) {
    cmdArgs.splice(2, 0, effectiveTestFile);
  }

  // Headed mode is the default for demos; headless opt-in disables it
  if (!args.headless) {
    cmdArgs.push('--headed');
  }

  // Per-test timeout (default 120s for demos)
  cmdArgs.push('--timeout', String(args.timeout ?? 120000));

  // Window recorder and screenshot capture — set up after Playwright spawns for headed recording
  let windowRecorder: { pid: number; process: ReturnType<typeof spawn> } | null = null;
  let windowRecordingPath: string | null = null;
  let screenshotCapture: { interval: ReturnType<typeof setInterval>; dir: string; startTime: number } | null = null;
  const shouldRecord = !args.headless && !args.skip_recording;

  // Start system metrics poller sidecar when telemetry is enabled
  let metricsPollerHandle: { stop: () => void } | null = null;

  try {
    const child = spawn('npx', cmdArgs, {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: EFFECTIVE_CWD,
      env,
    });

    // Launch system metrics poller after child process is spawned (needs child PID)
    if (telemetryEnabled && telemetryDir && child.pid) {
      import('./telemetry-capture.js').then(mod => {
        metricsPollerHandle = mod.startSystemMetricsPoller({
          outputPath: path.join(telemetryDir!, 'system-metrics.jsonl'),
          intervalMs: 2000,
          playwrightPid: child.pid!,
          runId,
        });
      }).catch(() => {}); // Non-fatal — module may not be built yet
    }

    // Collect stderr for crash diagnostics and track progress
    let stderrChunks: Buffer[] = [];
    let lastProgressAt = Date.now();
    let lastOutputLine = '';

    const MAX_STDOUT_LINES = 50;
    let stdoutLines: string[] = [];
    if (child.stdout) {
      child.stdout.on('data', (chunk: Buffer) => {
        lastProgressAt = Date.now();
        const lines = chunk.toString('utf8').split('\n').filter(l => l.trim());
        stdoutLines.push(...lines);
        if (stdoutLines.length > MAX_STDOUT_LINES) stdoutLines = stdoutLines.slice(-MAX_STDOUT_LINES);
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk);
        lastProgressAt = Date.now();
        // Track last output line for stall diagnostics
        const text = chunk.toString('utf8');
        const lines = text.split('\n').filter(l => l.trim());
        if (lines.length > 0) {
          lastOutputLine = lines[lines.length - 1].trim().slice(0, 200);
        }
      });
    }

    // For headed recording: wait for Chrome to appear, then start recording
    if (shouldRecord) {
      const recorderBinary = getWindowRecorderBinary();
      if (recorderBinary) {
        await waitForChromeWindow(30000);
        windowRecordingPath = path.join(PROJECT_DIR, '.claude', 'state', `demo-window-${progressId}.mp4`);
        windowRecorder = startWindowRecorder(windowRecordingPath, 'Chrome for Testing');

        // Wait briefly to detect fast permission failures (exit code 2).
        // With the CGPreflightScreenCaptureAccess() gate, the recorder exits within ~100ms
        // when permission is denied. Without this wait, run_demo returns "Video recording active"
        // and the agent doesn't discover the error until check_demo_result — often after 16+ retries.
        if (windowRecorder) {
          const recDiag = recorderDiagnostics.get(windowRecorder.pid);
          await new Promise(resolve => setTimeout(resolve, 1500));
          if (recDiag && recDiag.exitCode !== null) {
            // Recorder already exited — permission denied or other fast failure
            windowRecorder = null;
          }
        }
      }
    }

    // Get Chrome window ID for targeted screenshot capture (macOS only).
    // Must be called after Chrome is already running (waitForChromeWindow above ensures this
    // for the recording path; for non-recording headed paths Chrome is already up at this point).
    const chromeWindowId = !args.headless ? await getChromeWindowId() : null;

    // Start periodic screenshot capture for headed demos (macOS only)
    if (!args.headless && args.scenario_id) {
      screenshotCapture = startScreenshotCapture(args.scenario_id, chromeWindowId);
    }

    // Progress-based monitoring constants
    const GRACE_MS = 30_000; // 30s startup grace — demos must emit progress early
    const STALL_MS = args.stall_timeout_ms ?? 45_000; // configurable stall threshold
    const CHECK_INTERVAL_MS = 5_000;
    const STARTUP_CHECK_MS = 15_000;
    let lastProgressEventAt = Date.now();
    let progressFileOffset = 0;
    let suiteEndDetectedAt: number | null = null;
    let interruptDetectedAt: number | null = null;

    /**
     * Read new JSONL lines from the progress file since the last read offset.
     * Updates lastProgressEventAt, suiteEndDetectedAt, and interruptDetectedAt as a side effect.
     */
    const readNewProgressEvents = (): number => {
      try {
        if (!fs.existsSync(progressFilePath)) return 0;
        const stat = fs.statSync(progressFilePath);
        if (stat.size <= progressFileOffset) return 0;
        const fd = fs.openSync(progressFilePath, 'r');
        let newData: Buffer;
        try {
          const newBytes = stat.size - progressFileOffset;
          newData = Buffer.allocUnsafe(newBytes);
          fs.readSync(fd, newData, 0, newBytes, progressFileOffset);
          progressFileOffset = stat.size;
        } finally {
          fs.closeSync(fd);
        }
        const newText = newData.toString('utf-8');
        const lastNewline = newText.lastIndexOf('\n');
        if (lastNewline === -1) {
          progressFileOffset -= newData.length;
          return 0;
        }
        progressFileOffset -= (newData.length - (lastNewline + 1));
        const completeText = newText.slice(0, lastNewline + 1);
        const newLines = completeText.split('\n').filter(Boolean);
        let meaningfulEventCount = 0;
        for (const line of newLines) {
          try {
            const event = JSON.parse(line);
            if (
              event.type === 'test_begin' ||
              event.type === 'test_end' ||
              event.type === 'suite_begin' ||
              event.type === 'suite_end' ||
              event.type === 'step' ||
              event.type === 'demo_interrupted'
            ) {
              lastProgressEventAt = Date.now();
              meaningfulEventCount++;
              if (event.type === 'suite_end' && suiteEndDetectedAt === null) {
                suiteEndDetectedAt = Date.now();
                const suiteEndEntry = demoRuns.get(demoPid);
                if (suiteEndEntry) suiteEndEntry.suite_end_detected_at = suiteEndDetectedAt;
              }
              if (event.type === 'demo_interrupted' && interruptDetectedAt === null) {
                interruptDetectedAt = Date.now();
                const interruptEntry = demoRuns.get(demoPid);
                if (interruptEntry) interruptEntry.interrupt_detected_at = interruptDetectedAt;
              }
            }
          } catch {
            // Skip malformed JSONL lines
          }
        }
        return meaningfulEventCount;
      } catch {
        return 0;
      }
    };

    // ── Register demo run immediately (before any waiting) ──
    const demoPid = child.pid!;
    const demoState: DemoRunState = {
      pid: demoPid,
      project,
      test_file: effectiveTestFile,
      started_at: new Date().toISOString(),
      status: 'running',
      progress_file: progressFilePath,
      scenario_id: args.scenario_id,
      success_pause_ms: args.headless ? 0 : (args.success_pause_ms ?? 0),
      run_id: runId,
      telemetry_dir: telemetryDir,
      compute_size_used: computeSizeUsed,
    };
    if (windowRecorder) {
      demoState.window_recorder_pid = windowRecorder.pid;
      demoState.window_recording_path = windowRecordingPath ?? undefined;
    }
    if (screenshotCapture) {
      demoState.screenshot_interval = screenshotCapture.interval;
      demoState.screenshot_dir = screenshotCapture.dir;
      demoState.screenshot_start_time = screenshotCapture.startTime;
    }
    // Track Steel session for cleanup if this is a stealth-only run
    if (steelOnlySessionId) {
      demoState.steel_session_id = steelOnlySessionId;
      demoState.execution_target = 'steel';
    }
    demoRuns.set(demoPid, demoState);

    // Attach remote routing warning so check_demo_result can surface it
    if (remoteRoutingWarning) {
      demoState.remote_routing_warning = remoteRoutingWarning;
    }

    persistDemoRuns();

    if (displayLockAutoAcquired) {
      displayLockAutoAcquiredPids.add(demoPid);
    }

    // Clear any stale interrupt signal file from a previous demo session
    // to prevent false interrupts on this new demo run.
    if (!args.headless) {
      try { fs.unlinkSync(path.join('/tmp', `claude-mcp-browser-bridge-${os.userInfo().username}`, 'demo-interrupt.signal')); } catch { /* not present */ }
    }

    // ── Background stall/suite_end/interrupt monitoring (fire-and-forget) ──
    // Continues running after runDemo returns. Cleaned up on child exit.
    const bgMonitorStart = Date.now();
    let lastBgPersistedAt = Date.now();
    const BG_PERSIST_INTERVAL_MS = 30_000; // Persist stdio data every 30s for crash recovery
    const INTERRUPT_GRACE_MS = 3_000; // 3s grace for test to wind down after interrupt
    const bgMonitorInterval = setInterval(() => {
      readNewProgressEvents();

      // Periodic crash-safe persistence of stdio data.
      // If the MCP server dies mid-demo, the most recent stdout/stderr
      // will be on disk for check_demo_result to recover.
      if (Date.now() - lastBgPersistedAt >= BG_PERSIST_INTERVAL_MS) {
        const bgEntry = demoRuns.get(demoPid);
        if (bgEntry && bgEntry.status === 'running') {
          bgEntry.stdout_tail = stdoutLines.join('\n').slice(0, 5000);
          bgEntry.stderr_tail = Buffer.concat(stderrChunks).toString('utf8').trim().slice(0, 5000);
          persistDemoRuns();
          lastBgPersistedAt = Date.now();
        }
      }

      // Check for extension-based interrupt signal (written by native host
      // when the Chrome extension content script detects Escape keydown).
      // This is the framework-level path — works without target project changes.
      if (!args.headless && interruptDetectedAt === null) {
        const signalPath = path.join('/tmp', `claude-mcp-browser-bridge-${os.userInfo().username}`, 'demo-interrupt.signal');
        try {
          fs.accessSync(signalPath);
          // Signal found — consume it and treat as interrupt
          try { fs.unlinkSync(signalPath); } catch { /* race with another reader */ }
          interruptDetectedAt = Date.now();
          const sigEntry = demoRuns.get(demoPid);
          if (sigEntry) sigEntry.interrupt_detected_at = interruptDetectedAt;
          // Write to progress file for consistency with the in-process path
          if (progressFilePath) {
            try {
              const event = JSON.stringify({
                type: 'demo_interrupted',
                timestamp: new Date().toISOString(),
                source: 'escape_key_extension',
              });
              fs.appendFileSync(progressFilePath, event + '\n');
            } catch { /* best-effort */ }
          }
        } catch {
          // Signal file doesn't exist — normal case, no interrupt
        }
      }

      // Demo interrupt handling: user pressed Escape in headed demo
      if (interruptDetectedAt !== null && Date.now() - interruptDetectedAt >= INTERRUPT_GRACE_MS) {
        clearInterval(bgMonitorInterval);
        const intEntry = demoRuns.get(demoPid);
        if (intEntry && (intEntry.status === 'running' || intEntry.status === 'interrupted')) {
          intEntry.status = 'interrupted';
          intEntry.failure_summary = 'Demo interrupted by user (Escape key)';

          // Stop window recorder WITHOUT persisting (discard recording)
          if (intEntry.window_recorder_pid && intEntry.window_recording_path) {
            stopWindowRecorderSync(intEntry.window_recorder_pid, intEntry.window_recording_path);
            try { fs.unlinkSync(intEntry.window_recording_path); } catch { /* Non-fatal */ }
            intEntry.window_recorder_pid = undefined;
            intEntry.window_recording_path = undefined;
          }

          // Stop screenshot capture
          if (intEntry.screenshot_interval) {
            stopScreenshotCapture(intEntry.screenshot_interval);
            intEntry.screenshot_interval = undefined;
          }

          // Pause the associated task via bypass request system
          const bypassId = pauseTaskForDemoInteraction(demoPid, intEntry.scenario_id);
          if (bypassId) intEntry.bypass_request_id = bypassId;

          persistDemoRuns();
          // Do NOT kill the process — browser stays alive for user interaction
          // Do NOT release display lock — user still using the browser
        }
        return;
      }

      // Suite_end auto-kill: once tests finish, wait for SUITE_END_KILL_DELAY_MS plus any
      // user-requested success pause (headed + no failures only) before SIGTERM
      if (suiteEndDetectedAt !== null) {
        const bgEntry = demoRuns.get(demoPid);
        const bgProgress = bgEntry?.progress_file ? readDemoProgress(bgEntry.progress_file) : null;
        const successPause = (!args.headless && !bgProgress?.has_failures && bgEntry?.success_pause_ms)
          ? bgEntry.success_pause_ms : 0;
        if (Date.now() - suiteEndDetectedAt >= SUITE_END_KILL_DELAY_MS + successPause) {
          clearInterval(bgMonitorInterval);
          suiteEndAutoKilledPids.add(demoPid);
          if (child.pid) {
            try { process.kill(-child.pid, 'SIGTERM'); } catch {}
          }
          return;
        }
      }

      // Stall detection (only after grace period, skip if disabled)
      if (STALL_MS > 0 && Date.now() - bgMonitorStart >= GRACE_MS) {
        const lastActivity = Math.max(lastProgressAt, lastProgressEventAt);
        const silenceMs = Date.now() - lastActivity;
        if (silenceMs >= STALL_MS) {
          clearInterval(bgMonitorInterval);
          const entry = demoRuns.get(demoPid);
          if (entry && entry.status === 'running') {
            entry.failure_summary = `Stalled: no progress for ${Math.round(STALL_MS / 1000)}s after ${Math.round(GRACE_MS / 1000)}s grace period. Last output: ${lastOutputLine || '(none)'}. FIX: The demo has a long-running operation that produces no output. Add console.warn('[demo-progress] ...') checkpoints every 10-15s inside helpers, break the operation into multiple test.step() blocks, or pass stall_timeout_ms with a higher value to run_demo. See "Progress Checkpoints" in the demo-manager agent definition.`;
            persistDemoRuns();
          }
          if (child.pid) {
            try { process.kill(-child.pid, 'SIGTERM'); } catch {}
          }
        }
      }
    }, CHECK_INTERVAL_MS);

    // ── Permanent exit handler (single source of truth for cleanup) ──
    child.on('exit', (code) => {
      clearInterval(bgMonitorInterval);
      clearPollTracking(demoPid);
      if (metricsPollerHandle) { metricsPollerHandle.stop(); metricsPollerHandle = null; }
      const entry = demoRuns.get(demoPid);
      if (!entry) return;

      // If already finalized (suite_end_killed via check_demo_result, interrupt, etc.), skip
      if (entry.status !== 'running') return;

      // Interrupt detected but process exited before background monitor handled it (race condition)
      if (interruptDetectedAt !== null) {
        entry.status = 'interrupted';
        entry.failure_summary = 'Demo interrupted by user (Escape key)';
        // Pause task if not already done by the background monitor
        if (!entry.bypass_request_id) {
          const bypassId = pauseTaskForDemoInteraction(demoPid, entry.scenario_id);
          if (bypassId) entry.bypass_request_id = bypassId;
        }
      } else if (suiteEndAutoKilledPids.has(demoPid)) {
        // Suite_end killed → treat as passed (background monitor set the flag before SIGTERM)
        const progress = readDemoProgress(progressFilePath);
        entry.status = (progress?.has_failures) ? 'failed' : 'passed';
        suiteEndAutoKilledPids.delete(demoPid);
      } else {
        entry.status = (code === 0) ? 'passed' : 'failed';
      }

      entry.ended_at = new Date().toISOString();
      entry.exit_code = code ?? undefined;
      entry.stdout_tail = stdoutLines.join('\n').slice(0, 5000);
      entry.stderr_tail = Buffer.concat(stderrChunks).toString('utf8').trim().slice(0, 5000);

      if (entry.status === 'failed') {
        // Read lastDemoFailure from test-failure-state.json for enriched context
        try {
          const failureStatePath = path.join(PROJECT_DIR, '.claude', 'test-failure-state.json');
          if (fs.existsSync(failureStatePath)) {
            const failureState = JSON.parse(fs.readFileSync(failureStatePath, 'utf-8'));
            if (failureState.lastDemoFailure) {
              entry.failure_summary = failureState.lastDemoFailure.failureDetails?.slice(0, 2000);
              entry.screenshot_paths = failureState.lastDemoFailure.screenshotPaths;
            }
          }
        } catch {
          // Non-fatal — failure details unavailable
        }

        // Scan test-results/ for screenshot PNGs (capped at 5)
        if (!entry.screenshot_paths || entry.screenshot_paths.length === 0) {
          try {
            const testResultsDir = path.join(PROJECT_DIR, 'test-results');
            if (fs.existsSync(testResultsDir)) {
              const screenshots: string[] = [];
              const walk = (dir: string) => {
                if (screenshots.length >= 5) return;
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const e of entries) {
                  if (screenshots.length >= 5) return;
                  const full = path.join(dir, e.name);
                  if (e.isDirectory()) walk(full);
                  else if (e.name.endsWith('.png')) screenshots.push(full);
                }
              };
              walk(testResultsDir);
              if (screenshots.length > 0) {
                entry.screenshot_paths = screenshots;
              }
            }
          } catch {
            // Non-fatal
          }
        }

        // Fallback: use stdout tail if no failure details from test-failure-state.json
        if (!entry.failure_summary && entry.stdout_tail) {
          entry.failure_summary = entry.stdout_tail.slice(0, 2000);
        }

        // Scan for all artifacts
        entry.artifacts = scanArtifacts();
      }

      // Parse trace for play-by-play (runs for both passed and failed)
      try {
        const testResultsDir = path.join(PROJECT_DIR, 'test-results');
        const traceZip = findTraceZip(testResultsDir);
        if (traceZip) {
          const summary = parseTraceZip(traceZip);
          if (summary) {
            entry.trace_summary = summary;
          }
        }
      } catch {
        // Non-fatal — trace parsing is best-effort
      }

      // Stop screenshot capture on process exit
      if (entry.screenshot_interval) {
        stopScreenshotCapture(entry.screenshot_interval);
        entry.screenshot_interval = undefined;
      }

      // Persist video recording for the scenario (runs for both passed and failed, NOT interrupted)
      if (entry.status === 'interrupted') {
        // Interrupted demos: stop recorder and discard recording (do NOT persist)
        if (entry.window_recorder_pid && entry.window_recording_path) {
          stopWindowRecorderSync(entry.window_recorder_pid, entry.window_recording_path);
          try { fs.unlinkSync(entry.window_recording_path); } catch { /* Non-fatal */ }
          entry.window_recorder_pid = undefined;
          entry.window_recording_path = undefined;
        }
      } else if (entry.scenario_id) {
        try {
          let videoToUse: string | undefined;

          if (entry.window_recorder_pid && entry.window_recording_path) {
            if (stopWindowRecorderSync(entry.window_recorder_pid, entry.window_recording_path)) {
              videoToUse = entry.window_recording_path;
            }
            entry.window_recorder_pid = undefined;
          }

          // Fallback: scan playwright-results/ and test-results/ for Playwright CDP-recorded .webm video
          if (!videoToUse) {
            try {
              const findWebm = (dir: string): string | null => {
                if (!fs.existsSync(dir)) return null;
                let largest: string | null = null;
                let largestSize = 0;
                const walk = (d: string) => {
                  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
                    const fp = path.join(d, f.name);
                    if (f.isDirectory()) walk(fp);
                    else if (f.name.endsWith('.webm')) {
                      const sz = fs.statSync(fp).size;
                      if (sz > largestSize) { largest = fp; largestSize = sz; }
                    }
                  }
                };
                walk(dir);
                return largest;
              };
              const webm = findWebm(path.join(EFFECTIVE_CWD, 'playwright-results'))
                        || findWebm(path.join(EFFECTIVE_CWD, 'test-results'))
                        || findWebm(path.join(PROJECT_DIR, 'playwright-results'))
                        || findWebm(path.join(PROJECT_DIR, 'test-results'));
              if (webm) {
                videoToUse = webm;
                process.stderr.write(`[playwright] Fallback: using Playwright CDP video: ${webm}\n`);
              }
            } catch { /* Non-fatal */ }
          }

          if (videoToUse) {
            persistScenarioRecording(entry.scenario_id, videoToUse);
          }

          // Clean up temp window recording file
          if (entry.window_recording_path) {
            try { fs.unlinkSync(entry.window_recording_path); } catch { /* Non-fatal */ }
            entry.window_recording_path = undefined;
          }
        } catch { /* Non-fatal */ }
      } else {
        // No scenario_id — still stop and clean up window recorder if running
        if (entry.window_recorder_pid && entry.window_recording_path) {
          try { process.kill(entry.window_recorder_pid, 'SIGKILL'); } catch { /* already dead */ }
          try { fs.unlinkSync(entry.window_recording_path); } catch { /* Non-fatal */ }
          entry.window_recorder_pid = undefined;
          entry.window_recording_path = undefined;
        }
      }

      // Clean up progress file (best-effort)
      if (entry.progress_file) {
        try { fs.unlinkSync(entry.progress_file); } catch { /* Non-fatal */ }
      }

      // Persist demo result to user-feedback.db (dedup guard: only once per demo)
      if (entry.scenario_id && !entry.result_persisted && (entry.status === 'passed' || entry.status === 'failed')) {
        persistDemoResult({
          scenarioId: entry.scenario_id,
          status: entry.status,
          executionMode: entry.remote ? 'remote' : 'local',
          startedAt: entry.started_at,
          completedAt: entry.ended_at ?? new Date().toISOString(),
          durationMs: entry.ended_at
            ? new Date(entry.ended_at).getTime() - new Date(entry.started_at).getTime()
            : Date.now() - new Date(entry.started_at).getTime(),
          flyMachineId: entry.fly_machine_id,
          branch: getDemoBranch() ?? undefined,
          failureReason: entry.failure_summary,
        });
        entry.result_persisted = true;
      }

      persistDemoRuns();

      // Release display lock on process exit (covers all paths: normal, failed, killed)
      autoReleaseDisplayLockForPid(demoPid);
    });

    // ── Quick startup check (15s) — catch immediate spawn failures ──
    // Returns early if process crashes during startup. Otherwise returns PID
    // for polling via check_demo_result. Stall/suite_end detection continues
    // in the background interval above.
    const earlyExit = await new Promise<{ code: number | null; signal: string | null } | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), STARTUP_CHECK_MS);
      const onExit = (code: number | null, signal: string | null) => {
        clearTimeout(timer);
        resolve({ code, signal });
      };
      child.once('exit', onExit);
      child.once('error', (err: Error) => onExit(1, err.message));
    });

    if (earlyExit) {
      // Process died within 15s — exit handler already ran and updated demoState.
      // Return the result directly so the caller knows immediately.
      const entry = demoRuns.get(demoPid);
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      const snippet = stderr.length > 2000 ? stderr.slice(0, 2000) + '...' : stderr;
      const stdout = stdoutLines.join('\n').trim();

      if (earlyExit.code === 0) {
        return {
          success: !(entry?.status === 'failed'),
          project,
          message: entry?.status === 'failed'
            ? `Demo completed with failures (exit code 0).${stdout ? `\nstdout: ${stdout.slice(0, 2000)}` : ''}`
            : `Demo completed successfully.${effectiveTestFile ? ` File: ${effectiveTestFile}.` : ''} Use check_demo_result with PID ${demoPid} for details.`,
          pid: demoPid,
          slow_mo,
          test_file: effectiveTestFile,
          execution_target: executionTargetResult?.target ?? 'local',
          execution_target_reason: executionTargetResult?.reason ?? 'Local execution (no remote routing attempted)',
          run_id: runId,
        };
      }

      return {
        success: false,
        project,
        message: `Playwright process crashed during startup (exit code: ${earlyExit.code}, signal: ${earlyExit.signal})${stdout ? `\nstdout: ${stdout.slice(0, 2000)}` : ''}${snippet ? `\nstderr: ${snippet}` : ''}`,
        execution_target: executionTargetResult?.target ?? 'local',
        execution_target_reason: executionTargetResult?.reason ?? 'Local execution (no remote routing attempted)',
      };
    }

    // ── Process still running — detach data accumulation but KEEP activity tracking ──
    // The stall detector needs stdout/stderr activity signals after the 15s startup check.
    // Without these listeners, lastProgressAt freezes and the stall detector relies solely
    // on JSONL progress events, causing false kills for demos with slow fixture setup.
    if (child.stdout) {
      child.stdout.removeAllListeners('data');
      child.stdout.on('data', (chunk: Buffer) => {
        lastProgressAt = Date.now();
        const lines = chunk.toString('utf8').split('\n').filter(l => l.trim());
        stdoutLines.push(...lines);
        if (stdoutLines.length > MAX_STDOUT_LINES) stdoutLines = stdoutLines.slice(-MAX_STDOUT_LINES);
      });
      child.stdout.resume();
    }
    if (child.stderr) {
      child.stderr.removeAllListeners('data');
      child.stderr.on('data', (chunk: Buffer) => {
        lastProgressAt = Date.now();
        stderrChunks.push(chunk);
        // Cap stderr buffer at 10KB to prevent unbounded memory growth
        let totalSize = stderrChunks.reduce((sum, c) => sum + c.length, 0);
        while (totalSize > 10240 && stderrChunks.length > 1) {
          const removed = stderrChunks.shift();
          if (removed) totalSize -= removed.length;
        }
        const text = chunk.toString('utf8');
        const lines = text.split('\n').filter(l => l.trim());
        if (lines.length > 0) {
          lastOutputLine = lines[lines.length - 1].trim().slice(0, 200);
        }
      });
      child.stderr.resume();
    }
    child.unref();
    recordPollTime(demoPid);

    const warningText = preflight.warnings.length > 0
      ? `\nWarnings:\n${preflight.warnings.map(w => `  - ${w}`).join('\n')}`
      : '';

    let recorderInfo = '';
    if (windowRecorder) {
      const diag = recorderDiagnostics.get(windowRecorder.pid);
      if (diag) {
        const elapsed = Date.now() - diag.startedAt;
        const diagFile = windowRecordingPath ? windowRecordingPath + '.diag' : null;
        const diagExists = diagFile && fs.existsSync(diagFile);
        const recFile = windowRecordingPath && fs.existsSync(windowRecordingPath);
        recorderInfo = `\nWindowRecorder: pid=${windowRecorder.pid}, elapsed=${elapsed}ms, exit=${diag.exitCode}, diagFile=${diagExists}, outputFile=${recFile}, stderr=${diag.stderr.trim().slice(0, 300) || '(empty)'}`;
      }
    } else if (!args.headless) {
      recorderInfo = `\nWindowRecorder: not started (binary=${getWindowRecorderBinary() ? 'found' : 'not found'})`;
    }

    let recordingStatus = '';
    let recordingPermissionError: string | undefined;
    if (windowRecorder) {
      recordingStatus = ' Video recording active.';
    } else if (args.headless) {
      recordingStatus = ' No video recording (headless mode).';
    } else if (args.skip_recording) {
      recordingStatus = ' No video recording (recording skipped).';
    } else {
      // Check if the recorder died with a permission error (exit code 2)
      const demoEntry = demoRuns.get(demoPid);
      if (demoEntry?.window_recorder_permission_error) {
        recordingPermissionError = demoEntry.window_recorder_permission_error;
        recordingStatus = ' RECORDING FAILED: Screen Recording permission denied. Grant permission to the claude binary in System Settings > Privacy & Security > Screen Recording, then restart the terminal. Do NOT retry — fix the permission first.';
      } else {
        recordingStatus = ' No video recording (window recorder unavailable).';
      }
    }

    return {
      success: true,
      project,
      message: `Demo launched for project "${project}" with ${slow_mo}ms slow motion.${effectiveTestFile ? ` Running file: ${effectiveTestFile}.` : ''} Use check_demo_result with PID ${demoPid} to monitor.${recordingStatus}${warningText}${recorderInfo}`,
      pid: child.pid,
      slow_mo,
      test_file: effectiveTestFile,
      ...(recordingPermissionError ? { recording_permission_error: recordingPermissionError } : {}),
      execution_target: executionTargetResult?.target ?? 'local',
      execution_target_reason: executionTargetResult?.reason ?? 'Local execution (no remote routing attempted)',
      run_id: runId,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      project,
      message: `Failed to launch headed demo: ${message}`,
      execution_target: executionTargetResult?.target ?? 'local',
      execution_target_reason: executionTargetResult?.reason ?? 'Local execution (no remote routing attempted)',
    };
  }
}

/**
 * Parse JSONL progress content string into a DemoProgress snapshot.
 * Extracted so the same logic can be reused for remote (raw string) and
 * local (file-based) progress reading without duplicating the switch-case.
 */
function parseDemoProgressFromString(content: string): DemoProgress | null {
  try {
    const lines = content.trim().split('\n').filter(Boolean);
    if (lines.length === 0) return null;

    const progress: DemoProgress = {
      tests_completed: 0,
      tests_passed: 0,
      tests_failed: 0,
      total_tests: null,
      current_test: null,
      current_file: null,
      has_failures: false,
      recent_errors: [],
      last_5_results: [],
      suite_completed: false,
      annotations: [],
      has_warnings: false,
      interrupted: false,
    };

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        switch (event.type) {
          case 'suite_begin':
            progress.total_tests = event.total_tests ?? null;
            break;
          case 'test_begin':
            progress.current_test = event.title ?? null;
            progress.current_file = event.file ?? null;
            break;
          case 'test_end':
            progress.tests_completed++;
            if (event.status === 'passed') progress.tests_passed++;
            if (event.status === 'failed' || event.status === 'timedOut') {
              progress.tests_failed++;
              progress.has_failures = true;
            }
            progress.last_5_results.push({ title: event.title, status: event.status });
            if (progress.last_5_results.length > 5) {
              progress.last_5_results.shift();
            }
            // Parse annotations from test_end events
            if (Array.isArray(event.annotations) && event.annotations.length > 0) {
              for (const ann of event.annotations) {
                if (progress.annotations.length >= 50) break;
                progress.annotations.push({
                  test_title: event.title ?? '',
                  type: ann.type ?? '',
                  description: ann.description ?? '',
                });
                if (ann.type === 'warning') {
                  progress.has_warnings = true;
                }
              }
            }
            // Current test is done
            progress.current_test = null;
            progress.current_file = null;
            break;
          case 'console_error':
            if (progress.recent_errors.length < 10) {
              progress.recent_errors.push(event.text?.slice(0, 500) ?? 'Unknown error');
            }
            // Don't set has_failures — stderr errors may be transient (404 for favicon,
            // hot-reload noise, etc.). Only actual test failures (test_end with failed status)
            // should trigger has_failures.
            break;
          case 'crash':
            progress.has_failures = true;
            if (event.stderr_snippet && progress.recent_errors.length < 10) {
              progress.recent_errors.push(String(event.stderr_snippet).slice(0, 2000));
            }
            if (event.stdout_snippet && progress.recent_errors.length < 10) {
              progress.recent_errors.push(`[stdout] ${String(event.stdout_snippet).slice(0, 2000)}`);
            }
            break;
          case 'suite_end':
            progress.current_test = null;
            progress.current_file = null;
            progress.suite_completed = true;
            break;
          case 'demo_interrupted':
            progress.interrupted = true;
            break;
        }
      } catch {
        // Skip malformed lines
      }
    }

    return progress;
  } catch {
    return null;
  }
}

/**
 * Read and parse the JSONL progress file to build a DemoProgress snapshot.
 * Delegates to parseDemoProgressFromString for the actual parsing logic.
 */
function readDemoProgress(progressFilePath: string): DemoProgress | null {
  try {
    if (!fs.existsSync(progressFilePath)) return null;
    const content = fs.readFileSync(progressFilePath, 'utf-8');
    return parseDemoProgressFromString(content);
  } catch {
    return null;
  }
}

/**
 * Extract degraded feature descriptions from warning annotations.
 */
function extractDegradedFeatures(progress: DemoProgress | null | undefined): string[] | undefined {
  if (!progress?.annotations?.length) return undefined;
  const degraded = progress.annotations
    .filter(a => a.type === 'warning')
    .map(a => `${a.test_title}: ${a.description}`);
  return degraded.length > 0 ? degraded : undefined;
}

/**
 * Build agent analysis guidance for a completed remote demo result.
 * Returns a REQUIRED action string for agents reviewing the result, or
 * undefined when the demo is still running.
 */
function buildRemoteAnalysisGuidance(
  status: DemoRunStatus,
  traceSummary: string | undefined,
  destDir: string,
): string | undefined {
  if (status === 'running') return undefined;

  if (status === 'passed') {
    return traceSummary
      ? 'REQUIRED: Review trace_summary for a play-by-play of browser actions to verify the expected workflow executed. The trace file is available in the artifacts directory for detailed inspection.'
      : `Remote demo passed. Full logs available at ${destDir}/stdout.log and ${destDir}/stderr.log for verification.`;
  }

  const parts: string[] = ['REQUIRED: This demo failed remotely.'];
  if (traceSummary) {
    parts.push('Review trace_summary for the play-by-play of browser actions leading to failure.');
  }
  parts.push(`Check failure_summary and stderr_tail for error details. Full logs at ${destDir}/stdout.log and ${destDir}/stderr.log.`);
  if (!traceSummary) {
    parts.push(`Trace files may be at ${destDir}/test-results/*/trace.zip for detailed inspection.`);
  }
  return parts.join(' ');
}

/**
 * Check the result of a previously launched demo run.
 * Reads from the in-memory tracking map (primary) or persisted state file (after MCP restart).
 */
async function checkDemoResult(args: CheckDemoResultArgs): Promise<CheckDemoResultResult> {
  const { pid } = args;

  // Check in-memory map first
  let entry = demoRuns.get(pid);

  // Fallback: reload persisted state (covers MCP restart)
  if (!entry) {
    loadPersistedDemoRuns();
    entry = demoRuns.get(pid);
  }

  if (!entry) {
    return {
      status: 'unknown',
      pid,
      scenario_id: undefined,
      message: `No demo run found for PID ${pid}. The process may have been launched before the MCP server started, or the PID is incorrect.`,
    };
  }

  // ── Remote demo result check ──
  if (entry.remote && entry.fly_machine_id) {
    try {
      const flyConfig = getFlyConfigFromServices();
      if (!flyConfig) {
        return { status: 'unknown', pid, message: 'Fly.io configuration not found — cannot check remote demo result.' };
      }
      const { resolved: flyResolved, failedKeys: flyFailedKeys } = resolveOpReferencesStrict({ FLY_API_TOKEN: flyConfig.apiToken });
      if (flyFailedKeys.length > 0) {
        return { status: 'unknown', pid, message: 'Failed to resolve FLY_API_TOKEN for remote demo result check.' };
      }
      // RAM value here is for API compatibility — the machine was already spawned with its RAM at run_demo time
      const checkRamConfig = readFlyMachineConfig();
      const remoteMachineConfig = {
        apiToken: flyResolved['FLY_API_TOKEN'],
        appName: flyConfig.appName,
        region: flyConfig.region || 'iad',
        machineSize: flyConfig.machineSize || 'shared-cpu-2x',
        machineRam: checkRamConfig.machineRamHeadless,
        maxConcurrentMachines: flyConfig.maxConcurrentMachines || 3,
        projectImageEnabled: flyConfig.projectImageEnabled,
      };
      const remoteHandle = {
        machineId: entry.fly_machine_id,
        appName: entry.fly_app_name || flyConfig.appName,
        region: flyConfig.region || 'iad',
        startedAt: new Date(entry.started_at).getTime(),
      };

      const { isMachineAlive, pullRemoteArtifacts, stopRemoteMachine, pollRemoteProgressRaw } = await import('./fly-runner.js');
      const alive = await isMachineAlive(remoteHandle, remoteMachineConfig);

      if (alive) {
        const durationSeconds = Math.round((Date.now() - new Date(entry.started_at).getTime()) / 1000);

        // Parse structured progress from remote JSONL
        let remoteProgress: DemoProgress | null = null;
        try {
          const rawText = await pollRemoteProgressRaw(remoteHandle, remoteMachineConfig);
          if (rawText) {
            remoteProgress = parseDemoProgressFromString(rawText);
          }
        } catch { /* non-fatal */ }

        // Build rich status message matching local format
        let runningMessage = `Remote demo running on ${entry.fly_machine_id}. Elapsed: ${durationSeconds}s.`;
        if (remoteProgress) {
          const total = remoteProgress.total_tests !== null ? `/${remoteProgress.total_tests}` : '';
          runningMessage = `Remote: ${remoteProgress.tests_completed}${total} tests (${remoteProgress.tests_passed} passed, ${remoteProgress.tests_failed} failed). Elapsed: ${durationSeconds}s.`;
          if (remoteProgress.current_test) {
            runningMessage += ` Current: ${remoteProgress.current_test}`;
          }
          if (remoteProgress.has_failures) {
            runningMessage += ` FAILURES DETECTED.`;
          }
        }

        return {
          status: 'running',
          pid,
          project: entry.project,
          scenario_id: entry.scenario_id,
          started_at: entry.started_at,
          duration_seconds: durationSeconds,
          progress: remoteProgress ?? undefined,
          degraded_features: extractDegradedFeatures(remoteProgress),
          remote: true,
          fly_machine_id: entry.fly_machine_id,
          message: runningMessage,
        };
      }

      // Machine stopped — use proactively-pulled artifacts if available, otherwise pull now
      const destDir = entry.artifacts_dest_dir || path.join(PROJECT_DIR, '.claude', 'state', `demo-remote-${entry.fly_machine_id}`);

      let artifactErrors: string[] = [];
      if (!entry.artifacts_pulled) {
        // Machine stopped before proactive pull could happen — try to pull now (may fail if machine is destroyed)
        fs.mkdirSync(destDir, { recursive: true });
        try {
          const pullResult = await pullRemoteArtifacts(remoteHandle, remoteMachineConfig, destDir);
          artifactErrors = pullResult.errors;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          process.stderr.write(`[fly-runner] Artifact pull failed: ${msg}\n`);
          artifactErrors.push(msg);
        }
      }

      let remoteExitCode = -1;
      try {
        const exitCodePath = path.join(destDir, 'exit-code');
        if (fs.existsSync(exitCodePath)) remoteExitCode = parseInt(fs.readFileSync(exitCodePath, 'utf-8').trim(), 10);
      } catch { /* non-fatal */ }

      let remoteStdoutTail = '';
      let remoteStderrTail = '';
      try { const p = path.join(destDir, 'stdout.log'); if (fs.existsSync(p)) remoteStdoutTail = fs.readFileSync(p, 'utf-8').slice(-5000); } catch { /* */ }
      try { const p = path.join(destDir, 'stderr.log'); if (fs.existsSync(p)) remoteStderrTail = fs.readFileSync(p, 'utf-8').slice(-5000); } catch { /* */ }

      // Parse structured progress from pulled progress.jsonl
      let remoteProgress: DemoProgress | null = null;
      try {
        const progressJsonlPath = path.join(destDir, 'progress.jsonl');
        remoteProgress = readDemoProgress(progressJsonlPath);
      } catch { /* non-fatal */ }

      // Parse trace from pulled artifacts
      let remoteTraceSummary: string | undefined;
      try {
        const traceZip = findTraceZip(destDir);
        if (traceZip) {
          remoteTraceSummary = parseTraceZip(traceZip) ?? undefined;
        }
      } catch { /* non-fatal */ }

      try { await stopRemoteMachine(remoteHandle, remoteMachineConfig); } catch { /* non-fatal */ }

      // Release Steel session if this was a Steel-backed run (dual-instance or stealth-only)
      if (entry.steel_session_id) {
        try {
          const { releaseSteelSession } = await import('./steel-runner.js');
          const steelSection = getSteelConfigFromServices();
          if (steelSection) {
            const { resolved } = resolveOpReferencesStrict({ STEEL_API_KEY: steelSection.apiKey });
            if (resolved['STEEL_API_KEY']) {
              await releaseSteelSession({ apiKey: resolved['STEEL_API_KEY'], orgId: steelSection.orgId }, entry.steel_session_id);
            }
          }
        } catch { /* non-fatal — Steel sessions auto-expire after timeout */ }
      }

      const entryWithInterval = entry as DemoRunState & { _remotePollInterval?: ReturnType<typeof setInterval> };
      if (entryWithInterval._remotePollInterval) clearInterval(entryWithInterval._remotePollInterval);

      const remoteStatus: DemoRunStatus = remoteExitCode === 0 ? 'passed' : remoteExitCode === -1 ? 'unknown' : 'failed';
      entry.status = remoteStatus;

      // Persist demo result to user-feedback.db (dedup guard: only once per demo)
      if (entry.scenario_id && !entry.result_persisted && (remoteStatus === 'passed' || remoteStatus === 'failed')) {
        const remoteCompletedAt = new Date().toISOString();
        const remoteFailureSummaryEarly = remoteProgress?.has_failures
          ? `${remoteProgress.tests_failed} test(s) failed out of ${remoteProgress.tests_completed}`
          : remoteStderrTail?.slice(-500) || undefined;
        persistDemoResult({
          scenarioId: entry.scenario_id,
          status: remoteStatus as 'passed' | 'failed',
          executionMode: 'remote',
          startedAt: entry.started_at,
          completedAt: remoteCompletedAt,
          durationMs: new Date(remoteCompletedAt).getTime() - new Date(entry.started_at).getTime(),
          flyMachineId: entry.fly_machine_id,
          branch: getDemoBranch() ?? undefined,
          failureReason: remoteFailureSummaryEarly,
        });
        entry.result_persisted = true;
      }

      demoRuns.delete(pid);
      persistDemoRuns();

      const remoteDuration = Math.round((Date.now() - new Date(entry.started_at).getTime()) / 1000);

      // Build structured failure_summary from progress (preferred) or stderr (fallback)
      const structuredFailureSummary = remoteProgress?.has_failures
        ? `${remoteProgress.tests_failed} test(s) failed out of ${remoteProgress.tests_completed}`
        : undefined;

      // Check for remote recording — persist to local recordings directory
      let remoteRecordingPath: string | undefined;
      let remoteRecordingSource: 'window' | 'none' = 'none';
      const pulledRecording = path.join(destDir, 'recording.mp4');
      let videoToUseRemote: string | undefined;
      if (fs.existsSync(pulledRecording) && fs.statSync(pulledRecording).size > 0) {
        videoToUseRemote = pulledRecording;
      }

      // Fallback: scan pulled artifacts for Playwright CDP .webm videos
      if (!videoToUseRemote) {
        try {
          const findWebmInDir = (dir: string): string | null => {
            if (!fs.existsSync(dir)) return null;
            let largest: string | null = null;
            let largestSize = 0;
            const walk = (d: string) => {
              for (const f of fs.readdirSync(d, { withFileTypes: true })) {
                const fp = path.join(d, f.name);
                if (f.isDirectory()) walk(fp);
                else if (f.name.endsWith('.webm')) {
                  const sz = fs.statSync(fp).size;
                  if (sz > largestSize) { largest = fp; largestSize = sz; }
                }
              }
            };
            walk(dir);
            return largest;
          };
          const remoteWebm = findWebmInDir(destDir);
          if (remoteWebm) {
            videoToUseRemote = remoteWebm;
            process.stderr.write(`[playwright] Remote fallback: using CDP video from artifacts: ${remoteWebm}\n`);
          }
        } catch { /* Non-fatal */ }
      }

      // Tigris fallback: if recording.mp4 was not pulled via exec or found as .webm,
      // attempt download from Tigris object storage (handles large MP4s that exceed exec API limit)
      if (!videoToUseRemote && entry.run_id) {
        try {
          const tigrisServicesPath = path.join(PROJECT_DIR, '.claude', 'config', 'services.json');
          const { isTigrisConfigured, resolveTigrisConfig, downloadArtifact: downloadFromTigris } = await import('./artifact-storage.js');
          if (isTigrisConfigured(tigrisServicesPath)) {
            const tigrisConfig = resolveTigrisConfig(opRead, tigrisServicesPath);
            if (tigrisConfig) {
              process.stderr.write(`[playwright] Attempting Tigris download for recording.mp4 (run: ${entry.run_id})\n`);
              const tigrisRecordingDest = path.join(destDir, 'recording.mp4');
              const ok = await downloadFromTigris(tigrisConfig, entry.run_id, 'recording.mp4', tigrisRecordingDest);
              if (ok) {
                videoToUseRemote = tigrisRecordingDest;
                process.stderr.write(`[playwright] Tigris download succeeded for recording.mp4\n`);
              }
            }
          }
        } catch (tigrisErr) {
          process.stderr.write(`[playwright] Tigris recording download failed (non-fatal): ${tigrisErr instanceof Error ? tigrisErr.message : String(tigrisErr)}\n`);
        }
      }

      if (videoToUseRemote) {
        if (entry.scenario_id) {
          try {
            persistScenarioRecording(entry.scenario_id, videoToUseRemote);
            remoteRecordingPath = path.join(PROJECT_DIR, '.claude', 'recordings', 'demos', `${entry.scenario_id}.mp4`);
            remoteRecordingSource = 'window';
          } catch (recErr) {
            process.stderr.write(`[playwright] Failed to persist remote recording: ${recErr instanceof Error ? recErr.message : String(recErr)}\n`);
          }
        } else {
          remoteRecordingPath = videoToUseRemote;
          remoteRecordingSource = 'window';
        }
      }

      // Extract failure frames from remote recording (same as local)
      let remoteFailureFrames: Array<{ file_path: string; timestamp_seconds: number }> | undefined;
      if (remoteRecordingPath && remoteRecordingSource === 'window' && remoteStatus !== 'passed' && remoteDuration > 0) {
        try {
          const frameResult = extractFramesFromVideo(remoteRecordingPath, remoteDuration, 3);
          if ('frames' in frameResult) {
            remoteFailureFrames = frameResult.frames;
          }
        } catch {
          // ffprobe/ffmpeg may not be available — non-fatal
        }
      }

      // Extract periodic screenshots from remote recording (parity with local screencapture)
      let remoteScreenshotHint: string | undefined;
      if (remoteRecordingPath && entry.scenario_id) {
        try {
          const ssDir = path.join(PROJECT_DIR, '.claude', 'recordings', 'demos', entry.scenario_id, 'screenshots');
          const ssCount = extractScreenshotsFromRecording(remoteRecordingPath, ssDir, 3);
          if (ssCount > 0) {
            remoteScreenshotHint = `${ssCount} screenshots captured (every 3s). Demo duration: ${remoteDuration}s. ` +
              `Use get_demo_screenshot({ scenario_id: "${entry.scenario_id}", timestamp_seconds: N }) to view any moment. ` +
              (remoteStatus === 'passed'
                ? 'IMPORTANT: You MUST analyze key screenshots to verify the demo visually matches user requirements.'
                : 'IMPORTANT: Analyze screenshots near the failure point to understand what the UI looked like when the test failed.');
          }
        } catch {
          // ffmpeg may not be available locally — non-fatal
        }
      }

      // ── Remote failure classification (shared classifier) ──
      let remoteOomDetected = false;
      let remoteComputeSizeSuggestion: string | undefined;
      if (remoteStatus === 'failed') {
        let remoteMachineLogContent = '';
        try {
          const machineLogPath = path.join(destDir, 'fly-machine.log');
          if (fs.existsSync(machineLogPath)) remoteMachineLogContent = fs.readFileSync(machineLogPath, 'utf-8');
        } catch { /* non-fatal */ }

        const remoteClassification = classifyFailure({
          exitCode: remoteExitCode,
          stderrTail: remoteStderrTail,
          machineLog: remoteMachineLogContent,
          durationSeconds: remoteDuration,
          computeSizeUsed: entry.compute_size_used,
          scenarioId: entry.scenario_id,
          progress: remoteProgress,
        });

        if (remoteClassification.classification === 'oom') {
          remoteOomDetected = true;
          remoteComputeSizeSuggestion = remoteClassification.suggestion;
        }
      }

      return {
        status: remoteStatus,
        pid,
        project: entry.project,
        scenario_id: entry.scenario_id,
        started_at: entry.started_at,
        duration_seconds: remoteDuration,
        stdout_tail: remoteStdoutTail || undefined,
        stderr_tail: remoteStderrTail || undefined,
        progress: remoteProgress ?? undefined,
        degraded_features: extractDegradedFeatures(remoteProgress),
        trace_summary: remoteTraceSummary,
        artifacts: [destDir],
        failure_summary: remoteExitCode !== 0
          ? (structuredFailureSummary || remoteStderrTail.slice(-500) || 'Remote demo failed')
          : undefined,
        recording_path: remoteRecordingPath,
        recording_source: remoteRecordingSource,
        screenshot_hint: remoteScreenshotHint,
        failure_frames: remoteFailureFrames,
        analysis_guidance: remoteRecordingPath
          ? `REQUIRED: ${remoteScreenshotHint ? `Review screenshots via get_demo_screenshot and ` : ''}Review the video recording at ${remoteRecordingPath} to verify the demo ran correctly. Use extract_video_frames to inspect specific moments.${remoteTraceSummary ? ' Also review trace_summary for the play-by-play of browser actions.' : ''}`
          : buildRemoteAnalysisGuidance(remoteStatus, remoteTraceSummary, destDir),
        message: remoteExitCode === 0
          ? `Remote demo passed on Fly.io (${remoteDuration}s).${remoteScreenshotHint ? ' Screenshots available via get_demo_screenshot.' : ''}${remoteTraceSummary ? ' Trace available in trace_summary.' : ''}${remoteRecordingPath ? ` Recording at ${remoteRecordingPath}.` : ''} Artifacts at ${destDir}`
          : `Remote demo failed (exit ${remoteExitCode}, ${remoteDuration}s). ${structuredFailureSummary || 'Check stderr_tail.'}${remoteScreenshotHint ? ' Screenshots available via get_demo_screenshot.' : ''}${remoteRecordingPath ? ` Recording at ${remoteRecordingPath}.` : ''} Artifacts at ${destDir}`,
        remote: true,
        fly_machine_id: entry.fly_machine_id,
        fly_region: remoteMachineConfig.region,
        ...(artifactErrors.length > 0 ? { artifact_errors: artifactErrors } : {}),
        oom_detected: remoteOomDetected || undefined,
        compute_size_suggestion: remoteComputeSizeSuggestion,
        compute_size_used: entry.compute_size_used,
        // Include machine diagnostics for crash analysis
        ...((() => {
          try {
            const machineLogPath = path.join(destDir, 'fly-machine.log');
            if (fs.existsSync(machineLogPath)) {
              return { fly_machine_log: fs.readFileSync(machineLogPath, 'utf-8').slice(-3000) };
            }
          } catch { /* non-fatal */ }
          return {};
        })()),
      };
    } catch (remoteCheckErr) {
      return { status: 'unknown', pid, message: `Failed to check remote demo result: ${remoteCheckErr instanceof Error ? remoteCheckErr.message : String(remoteCheckErr)}` };
    }
  }

  // Interrupted demos: browser is alive for user interaction
  if (entry.status === 'interrupted') {
    recordPollTime(pid);
    const progress = entry.progress_file ? readDemoProgress(entry.progress_file) : null;
    return {
      status: 'interrupted',
      pid,
      project: entry.project,
      scenario_id: entry.scenario_id,
      started_at: entry.started_at,
      progress: progress ?? undefined,
      message: 'Demo was interrupted by user (Escape key). Browser is still open for manual interaction. Call stop_demo when done.',
    };
  }

  // For 'running' entries, verify process is still alive
  if (entry.status === 'running') {
    try {
      process.kill(pid, 0); // Signal 0 = check if process exists

      // Process alive — but check if suite already completed (stops unnecessary video recording)
      const progress = entry.progress_file ? readDemoProgress(entry.progress_file) : null;
      if (progress?.suite_completed) {
        // If success pause is active and time hasn't elapsed, don't kill yet
        if (!progress.has_failures && entry.success_pause_ms && entry.suite_end_detected_at) {
          const elapsed = Date.now() - entry.suite_end_detected_at;
          const totalDelay = SUITE_END_KILL_DELAY_MS + entry.success_pause_ms;
          if (elapsed < totalDelay) {
            recordPollTime(pid);
            const remainingSec = Math.ceil((totalDelay - elapsed) / 1000);
            return {
              status: 'running',
              pid,
              project: entry.project,
              scenario_id: entry.scenario_id,
              progress,
              message: `Demo passed — pausing ${remainingSec}s on success state before teardown (${totalDelay - elapsed}ms remaining)`,
            };
          }
        }
        // Suite done — stop window recorder first (sync), then kill playwright process
        let recorderClean = false;
        if (entry.window_recorder_pid && entry.window_recording_path) {
          recorderClean = stopWindowRecorderSync(entry.window_recorder_pid, entry.window_recording_path);
          entry.window_recorder_pid = undefined;
        }

        clearPollTracking(pid);
        try { process.kill(-pid, 'SIGTERM'); } catch {}
        suiteEndAutoKilledPids.add(pid);
        entry.status = progress.has_failures ? 'failed' : 'passed';
        entry.ended_at = new Date().toISOString();
        entry.failure_summary = progress.has_failures
          ? `${progress.tests_failed} test(s) failed out of ${progress.tests_completed}`
          : undefined;

        // Clean up progress file
        if (entry.progress_file) {
          try { fs.unlinkSync(entry.progress_file); } catch { /* Non-fatal */ }
        }

        // Scan for artifacts
        entry.artifacts = scanArtifacts();

        // Persist video recording for the scenario
        let suiteRecordingPath: string | undefined;
        let suiteRecordingSource: 'window' | 'none' = 'none';
        if (entry.scenario_id) {
          try {
            let videoToUse: string | undefined;

            // Prefer window recording (only if recorder exited cleanly)
            if (
              recorderClean &&
              entry.window_recording_path &&
              fs.existsSync(entry.window_recording_path) &&
              fs.statSync(entry.window_recording_path).size > 0
            ) {
              videoToUse = entry.window_recording_path;
              suiteRecordingSource = 'window';
            }

            if (videoToUse) {
              persistScenarioRecording(entry.scenario_id, videoToUse);
              suiteRecordingPath = path.join(PROJECT_DIR, '.claude', 'recordings', 'demos', `${entry.scenario_id}.mp4`);
            }

            // Clean up temp window recording file
            if (entry.window_recording_path) {
              try { fs.unlinkSync(entry.window_recording_path); } catch { /* Non-fatal */ }
              entry.window_recording_path = undefined;
            }
          } catch { /* Non-fatal */ }
        } else if (entry.window_recording_path) {
          try { fs.unlinkSync(entry.window_recording_path); } catch { /* Non-fatal */ }
          entry.window_recording_path = undefined;
        }

        entry.window_recorder_pid = undefined;

        // Stop screenshot capture — suite completed
        if (entry.screenshot_interval) {
          stopScreenshotCapture(entry.screenshot_interval);
          entry.screenshot_interval = undefined;
        }

        // Parse trace if available
        try {
          const testResultsDir = path.join(PROJECT_DIR, 'test-results');
          const traceZip = findTraceZip(testResultsDir);
          if (traceZip) {
            const summary = parseTraceZip(traceZip);
            if (summary) entry.trace_summary = summary;
          }
        } catch { /* non-fatal */ }

        // Persist demo result to user-feedback.db (dedup guard: only once per demo)
        if (entry.scenario_id && !entry.result_persisted && (entry.status === 'passed' || entry.status === 'failed')) {
          persistDemoResult({
            scenarioId: entry.scenario_id,
            status: entry.status,
            executionMode: entry.remote ? 'remote' : 'local',
            startedAt: entry.started_at,
            completedAt: entry.ended_at ?? new Date().toISOString(),
            durationMs: entry.ended_at
              ? new Date(entry.ended_at).getTime() - new Date(entry.started_at).getTime()
              : Date.now() - new Date(entry.started_at).getTime(),
            flyMachineId: entry.fly_machine_id,
            branch: getDemoBranch() ?? undefined,
            failureReason: entry.failure_summary,
          });
          entry.result_persisted = true;
        }

        persistDemoRuns();

        const durationSec = Math.round((Date.now() - new Date(entry.started_at).getTime()) / 1000);
        const degraded = extractDegradedFeatures(progress);
        const degradedSuffix = degraded?.length ? ` (${degraded.length} degraded feature(s))` : '';

        // Build screenshot hint
        const screenshotDir1 = entry.scenario_id
          ? path.join(PROJECT_DIR, '.claude', 'recordings', 'demos', entry.scenario_id, 'screenshots')
          : undefined;
        const screenshotFiles1 = screenshotDir1 && fs.existsSync(screenshotDir1)
          ? fs.readdirSync(screenshotDir1).filter(f => f.endsWith('.png'))
          : [];
        const isPassedPath1 = entry.status === 'passed';
        const screenshotHint1 = screenshotFiles1.length > 0
          ? isPassedPath1
            ? `${screenshotFiles1.length} screenshots captured (every 3s). Demo duration: ${durationSec}s. Use get_demo_screenshot({ scenario_id: "${entry.scenario_id}", timestamp_seconds: N }) to view any moment. IMPORTANT: You MUST analyze key screenshots to verify the demo visually matches user requirements — screenshots are your second layer of verification beyond pass/fail test results.`
            : `${screenshotFiles1.length} screenshots captured (every 3s). Demo duration: ${durationSec}s. Use get_demo_screenshot({ scenario_id: "${entry.scenario_id}", timestamp_seconds: N }) to view any moment. IMPORTANT: Analyze screenshots near the failure point to understand what the UI looked like when the test failed.`
          : undefined;

        // Auto-extract failure frames from video recording
        let failureFrames1: Array<{ file_path: string; timestamp_seconds: number }> | undefined;
        if (entry.status === 'failed' && suiteRecordingPath) {
          try {
            const extraction1 = extractFramesFromVideo(suiteRecordingPath, durationSec, 3);
            if (!('error' in extraction1)) {
              failureFrames1 = extraction1.frames;
            }
          } catch { /* Non-fatal */ }
        }

        // Build analysis guidance
        const hasMediaPath1 = screenshotFiles1.length > 0 || !!suiteRecordingPath;
        const analysisGuidance1: string | undefined = !hasMediaPath1
          ? undefined
          : entry.status === 'passed'
            ? 'REQUIRED: Before reporting this demo as successful, use get_demo_screenshot to view screenshots at key moments (start, middle, end) and verify the UI matches user requirements. If a video recording is available, use extract_video_frames at critical steps for detailed frame-by-frame verification. Screenshots and video frames are available via the Read tool.'
            : suiteRecordingPath
              ? `REQUIRED: This demo failed. ${failureFrames1 ? `${failureFrames1.length} frames have been auto-extracted from the 3 seconds before failure — analyze them with the Read tool to understand what went wrong visually.` : 'Use extract_video_frames at the failure timestamp to see what the UI looked like when it broke.'} Also check screenshots via get_demo_screenshot for earlier moments that may reveal when things started going wrong.`
              : 'REQUIRED: This demo failed. Use get_demo_screenshot to view screenshots near the failure point and understand what the UI looked like. Check screenshots at multiple timestamps to identify when the failure pattern first appeared.';

        // Auto-release display lock if this demo auto-acquired it
        autoReleaseDisplayLockForPid(pid);

        return {
          status: entry.status,
          pid,
          scenario_id: entry.scenario_id,
          project: entry.project,
          test_file: entry.test_file,
          started_at: entry.started_at,
          ended_at: entry.ended_at,
          failure_summary: entry.failure_summary,
          screenshot_paths: entry.screenshot_paths,
          trace_summary: entry.trace_summary,
          progress,
          artifacts: entry.artifacts,
          degraded_features: degraded,
          recording_path: suiteRecordingPath,
          recording_source: suiteRecordingSource,
          recording_permission_error: entry.window_recorder_permission_error,
          duration_seconds: durationSec,
          screenshot_hint: screenshotHint1,
          failure_frames: failureFrames1,
          analysis_guidance: analysisGuidance1,
          ...(entry.remote_routing_warning ? { remote_routing_warning: entry.remote_routing_warning } : {}),
          ...(entry.image_staleness_warning ? { image_staleness_warning: entry.image_staleness_warning } : {}),
          message: entry.status === 'passed'
            ? `Demo completed successfully in ${durationSec}s (process terminated after suite completion).${degradedSuffix}`
            : `Demo failed in ${durationSec}s — ${entry.failure_summary}. Process terminated after suite completion.`,
        };
      }

      // Suite still running — record poll time for stale tracking
      recordPollTime(pid);
    } catch {
      // Process no longer exists but we didn't get the exit event (e.g., MCP restarted, user closed browser)
      clearPollTracking(pid);
      entry.ended_at = new Date().toISOString();

      // Stop window recorder and persist video before returning
      if (entry.window_recorder_pid && entry.window_recording_path) {
        const recOk = stopWindowRecorderSync(entry.window_recorder_pid, entry.window_recording_path);
        if (recOk && entry.scenario_id) {
          try { persistScenarioRecording(entry.scenario_id, entry.window_recording_path); } catch { /* Non-fatal */ }
        }
        try { fs.unlinkSync(entry.window_recording_path); } catch { /* Non-fatal */ }
        entry.window_recorder_pid = undefined;
        entry.window_recording_path = undefined;
      }

      // Stop screenshot capture — process no longer running
      if (entry.screenshot_interval) {
        stopScreenshotCapture(entry.screenshot_interval);
        entry.screenshot_interval = undefined;
      }

      // Read progress file to determine final status instead of returning 'unknown'
      const finalProgress = entry.progress_file ? readDemoProgress(entry.progress_file) : null;
      if (finalProgress && finalProgress.tests_completed > 0) {
        // We have test results — determine pass/fail from progress data
        entry.status = finalProgress.has_failures ? 'failed' : 'passed';
        entry.failure_summary = finalProgress.has_failures
          ? `${finalProgress.tests_failed} test(s) failed out of ${finalProgress.tests_completed}`
          : undefined;
      } else {
        entry.status = 'unknown';
        // Use stderr as fallback failure summary when no other diagnostics are available
        if (!entry.failure_summary && entry.stderr_tail) {
          entry.failure_summary = `Process stderr: ${entry.stderr_tail.slice(0, 2000)}`;
        }
      }

      // Scan for artifacts when process ended unexpectedly
      entry.artifacts = scanArtifacts();

      // Parse trace if available
      try {
        const testResultsDir = path.join(PROJECT_DIR, 'test-results');
        const traceZip = findTraceZip(testResultsDir);
        if (traceZip) {
          const summary = parseTraceZip(traceZip);
          if (summary) entry.trace_summary = summary;
        }
      } catch { /* non-fatal */ }

      // Persist demo result to user-feedback.db (dedup guard: only once per demo)
      if (entry.scenario_id && !entry.result_persisted && (entry.status === 'passed' || entry.status === 'failed')) {
        persistDemoResult({
          scenarioId: entry.scenario_id,
          status: entry.status as 'passed' | 'failed',
          executionMode: entry.remote ? 'remote' : 'local',
          startedAt: entry.started_at,
          completedAt: entry.ended_at ?? new Date().toISOString(),
          durationMs: entry.ended_at
            ? new Date(entry.ended_at).getTime() - new Date(entry.started_at).getTime()
            : Date.now() - new Date(entry.started_at).getTime(),
          flyMachineId: entry.fly_machine_id,
          branch: getDemoBranch() ?? undefined,
          failureReason: entry.failure_summary,
        });
        entry.result_persisted = true;
      }

      persistDemoRuns();

      const durationSec = Math.round((Date.now() - new Date(entry.started_at).getTime()) / 1000);
      const statusMsg = entry.status === 'passed'
        ? `Demo completed successfully in ${durationSec}s (status recovered from progress file).`
        : entry.status === 'failed'
          ? `Demo failed in ${durationSec}s — ${entry.failure_summary}. Status recovered from progress file.`
          : `Demo process (PID ${pid}) is no longer running but no test results were captured. Check test-results/ for output.`;

      // Build screenshot hint for process-dead path
      const screenshotDir2 = entry.scenario_id
        ? path.join(PROJECT_DIR, '.claude', 'recordings', 'demos', entry.scenario_id, 'screenshots')
        : undefined;
      const screenshotFiles2 = screenshotDir2 && fs.existsSync(screenshotDir2)
        ? fs.readdirSync(screenshotDir2).filter(f => f.endsWith('.png'))
        : [];
      const isPassedPath2 = entry.status === 'passed';
      const screenshotHint2 = screenshotFiles2.length > 0
        ? isPassedPath2
          ? `${screenshotFiles2.length} screenshots captured (every 3s). Demo duration: ${durationSec}s. Use get_demo_screenshot({ scenario_id: "${entry.scenario_id}", timestamp_seconds: N }) to view any moment. IMPORTANT: You MUST analyze key screenshots to verify the demo visually matches user requirements — screenshots are your second layer of verification beyond pass/fail test results.`
          : `${screenshotFiles2.length} screenshots captured (every 3s). Demo duration: ${durationSec}s. Use get_demo_screenshot({ scenario_id: "${entry.scenario_id}", timestamp_seconds: N }) to view any moment. IMPORTANT: Analyze screenshots near the failure point to understand what the UI looked like when the test failed.`
        : undefined;

      // Check for persisted recording in process-dead path
      const processDeadRecordingPath = entry.scenario_id
        ? path.join(PROJECT_DIR, '.claude', 'recordings', 'demos', `${entry.scenario_id}.mp4`)
        : undefined;
      const hasProcessDeadRecording = processDeadRecordingPath && fs.existsSync(processDeadRecordingPath);

      // Auto-extract failure frames from video recording
      let failureFrames2: Array<{ file_path: string; timestamp_seconds: number }> | undefined;
      if (entry.status === 'failed' && hasProcessDeadRecording && processDeadRecordingPath) {
        try {
          const extraction2 = extractFramesFromVideo(processDeadRecordingPath, durationSec, 3);
          if (!('error' in extraction2)) {
            failureFrames2 = extraction2.frames;
          }
        } catch { /* Non-fatal */ }
      }

      // Build analysis guidance
      const hasMediaPath2 = screenshotFiles2.length > 0 || hasProcessDeadRecording;
      const analysisGuidance2: string | undefined = !hasMediaPath2
        ? undefined
        : entry.status === 'passed'
          ? 'REQUIRED: Before reporting this demo as successful, use get_demo_screenshot to view screenshots at key moments (start, middle, end) and verify the UI matches user requirements. If a video recording is available, use extract_video_frames at critical steps for detailed frame-by-frame verification. Screenshots and video frames are available via the Read tool.'
          : hasProcessDeadRecording
            ? `REQUIRED: This demo failed. ${failureFrames2 ? `${failureFrames2.length} frames have been auto-extracted from the 3 seconds before failure — analyze them with the Read tool to understand what went wrong visually.` : 'Use extract_video_frames at the failure timestamp to see what the UI looked like when it broke.'} Also check screenshots via get_demo_screenshot for earlier moments that may reveal when things started going wrong.`
            : 'REQUIRED: This demo failed. Use get_demo_screenshot to view screenshots near the failure point and understand what the UI looked like. Check screenshots at multiple timestamps to identify when the failure pattern first appeared.';

      // Auto-release display lock if this demo auto-acquired it — process is dead
      autoReleaseDisplayLockForPid(pid);

      return {
        status: entry.status,
        pid,
        scenario_id: entry.scenario_id,
        project: entry.project,
        test_file: entry.test_file,
        started_at: entry.started_at,
        ended_at: entry.ended_at,
        failure_summary: entry.failure_summary,
        stderr_tail: entry.stderr_tail,
        screenshot_paths: entry.screenshot_paths,
        trace_summary: entry.trace_summary,
        progress: finalProgress ?? undefined,
        artifacts: entry.artifacts,
        degraded_features: extractDegradedFeatures(finalProgress),
        recording_path: hasProcessDeadRecording ? processDeadRecordingPath : undefined,
        recording_source: hasProcessDeadRecording ? 'window' as const : 'none' as const,
        recording_permission_error: entry.window_recorder_permission_error,
        duration_seconds: durationSec,
        screenshot_hint: screenshotHint2,
        failure_frames: failureFrames2,
        analysis_guidance: analysisGuidance2,
        ...(entry.remote_routing_warning ? { remote_routing_warning: entry.remote_routing_warning } : {}),
        ...(entry.image_staleness_warning ? { image_staleness_warning: entry.image_staleness_warning } : {}),
        message: statusMsg,
      };
    }
  }

  const durationMs = entry.ended_at
    ? new Date(entry.ended_at).getTime() - new Date(entry.started_at).getTime()
    : Date.now() - new Date(entry.started_at).getTime();
  const durationSec = Math.round(durationMs / 1000);

  // Read progress data from JSONL file when available
  const progress = entry.progress_file ? readDemoProgress(entry.progress_file) : null;

  // Build status message with progress context
  let runningMessage = `Demo is still running (${durationSec}s elapsed).`;
  if (progress && entry.status === 'running') {
    const total = progress.total_tests !== null ? `/${progress.total_tests}` : '';
    runningMessage = `Running: ${progress.tests_completed}${total} tests (${progress.tests_passed} passed, ${progress.tests_failed} failed).`;
    if (progress.current_test) {
      runningMessage += ` Current: ${progress.current_test}`;
    }
    if (progress.has_failures) {
      runningMessage += ` FAILURES DETECTED.`;
    }
  }

  const statusMessages: Record<string, string> = {
    running: runningMessage,
    passed: `Demo completed successfully in ${durationSec}s.${entry.trace_summary ? ' Play-by-play trace available in trace_summary.' : ''}`,
    failed: `Demo failed (exit code ${entry.exit_code}) after ${durationSec}s.${entry.failure_summary ? ' See failure_summary for details.' : ''}${entry.trace_summary ? ' Play-by-play trace available in trace_summary.' : ''}`,
    unknown: `Demo status unknown for PID ${pid}.`,
  };

  // Fallback failure_summary from stdout_tail
  const failureSummary = entry.failure_summary || (entry.status === 'failed' ? entry.stdout_tail?.slice(0, 2000) : undefined);

  const degraded_features = extractDegradedFeatures(progress);
  let message = statusMessages[entry.status] || `Demo status: ${entry.status}`;
  if (degraded_features && degraded_features.length > 0 && entry.status !== 'running') {
    message += ` (${degraded_features.length} degraded feature(s))`;
  }

  // Check if a window recording was persisted for this scenario
  let finalRecordingPath: string | undefined;
  let finalRecordingSource: 'window' | 'none' = 'none';
  if (entry.scenario_id) {
    const scenarioRecordingPath = path.join(PROJECT_DIR, '.claude', 'recordings', 'demos', `${entry.scenario_id}.mp4`);
    if (fs.existsSync(scenarioRecordingPath)) {
      finalRecordingPath = scenarioRecordingPath;
      finalRecordingSource = 'window';
    }
  }

  // Build screenshot hint for catch-all return (completed or running)
  const screenshotDirFinal = entry.scenario_id
    ? path.join(PROJECT_DIR, '.claude', 'recordings', 'demos', entry.scenario_id, 'screenshots')
    : undefined;
  const screenshotFilesFinal = screenshotDirFinal && fs.existsSync(screenshotDirFinal)
    ? fs.readdirSync(screenshotDirFinal).filter(f => f.endsWith('.png'))
    : [];
  const isPassedFinal = entry.status === 'passed';
  // Only include screenshot_hint when demo is completed (not still running)
  const screenshotHintFinal = screenshotFilesFinal.length > 0 && entry.status !== 'running'
    ? isPassedFinal
      ? `${screenshotFilesFinal.length} screenshots captured (every 3s). Demo duration: ${durationSec}s. Use get_demo_screenshot({ scenario_id: "${entry.scenario_id}", timestamp_seconds: N }) to view any moment. IMPORTANT: You MUST analyze key screenshots to verify the demo visually matches user requirements — screenshots are your second layer of verification beyond pass/fail test results.`
      : `${screenshotFilesFinal.length} screenshots captured (every 3s). Demo duration: ${durationSec}s. Use get_demo_screenshot({ scenario_id: "${entry.scenario_id}", timestamp_seconds: N }) to view any moment. IMPORTANT: Analyze screenshots near the failure point to understand what the UI looked like when the test failed.`
    : undefined;

  // Auto-extract failure frames from video recording
  let failureFramesFinal: Array<{ file_path: string; timestamp_seconds: number }> | undefined;
  if (entry.status === 'failed' && finalRecordingPath) {
    try {
      const extractionFinal = extractFramesFromVideo(finalRecordingPath, durationSec, 3);
      if (!('error' in extractionFinal)) {
        failureFramesFinal = extractionFinal.frames;
      }
    } catch { /* Non-fatal */ }
  }

  // Build analysis guidance for catch-all path (only for completed demos, not running)
  const hasMediaFinal = screenshotFilesFinal.length > 0 || !!finalRecordingPath;
  const analysisGuidanceFinal: string | undefined = entry.status === 'running' || !hasMediaFinal
    ? undefined
    : entry.status === 'passed'
      ? 'REQUIRED: Before reporting this demo as successful, use get_demo_screenshot to view screenshots at key moments (start, middle, end) and verify the UI matches user requirements. If a video recording is available, use extract_video_frames at critical steps for detailed frame-by-frame verification. Screenshots and video frames are available via the Read tool.'
      : finalRecordingPath
        ? `REQUIRED: This demo failed. ${failureFramesFinal ? `${failureFramesFinal.length} frames have been auto-extracted from the 3 seconds before failure — analyze them with the Read tool to understand what went wrong visually.` : 'Use extract_video_frames at the failure timestamp to see what the UI looked like when it broke.'} Also check screenshots via get_demo_screenshot for earlier moments that may reveal when things started going wrong.`
        : 'REQUIRED: This demo failed. Use get_demo_screenshot to view screenshots near the failure point and understand what the UI looked like. Check screenshots at multiple timestamps to identify when the failure pattern first appeared.';

  // Auto-release display lock when demo reaches terminal state
  if (entry.status !== 'running') {
    autoReleaseDisplayLockForPid(pid);
  }

  // Look up permission error from recorderDiagnostics if not yet cached in state
  // (covers the case where the exit event fires after this call but before PID is cleared)
  let recorderPermissionError = entry.window_recorder_permission_error;
  if (!recorderPermissionError && entry.window_recorder_pid) {
    const recDiag = recorderDiagnostics.get(entry.window_recorder_pid);
    if (recDiag?.exitCode === 2) {
      recorderPermissionError = recDiag.stderr.trim().slice(0, 2000) ||
        'WindowRecorder exited with code 2: Screen Recording permission is denied for this process.';
    }
  }

  // ── Failure classification (shared classifier) ──
  let oomDetected = false;
  let computeSizeSuggestion: string | undefined;
  if (entry.status === 'failed') {
    let localMachineLogContent = '';
    if (entry.remote && entry.artifacts_dest_dir) {
      try {
        const machineLogPath = path.join(entry.artifacts_dest_dir, 'fly-machine.log');
        if (fs.existsSync(machineLogPath)) localMachineLogContent = fs.readFileSync(machineLogPath, 'utf-8');
      } catch { /* non-fatal */ }
    }
    const localClassification = classifyFailure({
      exitCode: entry.exit_code ?? -1,
      stderrTail: entry.stderr_tail || '',
      machineLog: localMachineLogContent,
      durationSeconds: durationSec,
      computeSizeUsed: entry.compute_size_used,
      scenarioId: entry.scenario_id,
      progress: progress,
    });
    if (localClassification.classification === 'oom') {
      oomDetected = true;
      computeSizeSuggestion = localClassification.suggestion;
    }
  }

  // Compute stale warning — computeStaleWarning() internally checks status === 'running'/'interrupted'
  // and returns undefined for terminal statuses, so it's safe to call unconditionally.
  const staleWarning = computeStaleWarning(pid);
  if (staleWarning) {
    message += ` ${staleWarning}`;
  }

  return {
    status: entry.status,
    pid,
    scenario_id: entry.scenario_id,
    project: entry.project,
    test_file: entry.test_file,
    started_at: entry.started_at,
    ended_at: entry.ended_at,
    exit_code: entry.exit_code,
    failure_summary: failureSummary,
    stderr_tail: entry.stderr_tail,
    screenshot_paths: entry.screenshot_paths,
    trace_summary: entry.trace_summary,
    progress: progress ?? undefined,
    artifacts: entry.artifacts || (entry.status === 'failed' || entry.status === 'unknown' ? scanArtifacts() : undefined),
    degraded_features,
    recording_path: finalRecordingPath,
    recording_source: finalRecordingSource,
    recording_permission_error: recorderPermissionError,
    duration_seconds: durationSec,
    screenshot_hint: screenshotHintFinal,
    failure_frames: failureFramesFinal,
    analysis_guidance: analysisGuidanceFinal,
    ...(entry.remote_routing_warning ? { remote_routing_warning: entry.remote_routing_warning } : {}),
    ...(entry.image_staleness_warning ? { image_staleness_warning: entry.image_staleness_warning } : {}),
    run_id: entry.run_id,
    telemetry_dir: entry.telemetry_dir,
    telemetry_summary: entry.telemetry_dir ? readTelemetrySummaryInline(entry.telemetry_dir) : undefined,
    stale_warning: staleWarning,
    oom_detected: oomDetected || undefined,
    compute_size_suggestion: computeSizeSuggestion,
    compute_size_used: entry.compute_size_used,
    message,
  };

  // Fire-and-forget Elastic shipping when demo is complete with telemetry
  const finalEntry = entry!; // Guaranteed non-null at this point (early returns above)
  if (finalEntry.telemetry_dir && finalEntry.run_id && finalEntry.status !== 'running') {
    const tDir = finalEntry.telemetry_dir!;
    const tRunId = finalEntry.run_id!;
    const tStatus = finalEntry.status;
    const tScenarioId = finalEntry.scenario_id || 'unknown';
    const tEndedAt = finalEntry.ended_at;
    const tStartedAt = finalEntry.started_at;
    const tExecTarget = finalEntry.execution_target || 'local';
    import('./telemetry-capture.js').then(mod => {
      mod.shipTelemetryToElastic({
        runId: tRunId,
        scenarioId: tScenarioId,
        telemetryDir: tDir,
        status: tStatus,
        durationMs: tEndedAt && tStartedAt
          ? new Date(tEndedAt).getTime() - new Date(tStartedAt).getTime()
          : 0,
        executionTarget: tExecTarget,
      }).catch(() => {});
    }).catch(() => {}); // Non-fatal — module may not be built yet
  }
}

function readTelemetrySummaryInline(dir: string): { console_count: number; network_count: number; error_count: number; perf_entries: number; metric_samples: number } | undefined {
  try {
    if (!fs.existsSync(dir)) return undefined;
    const countLines = (file: string): number => {
      try {
        const p = path.join(dir, file);
        if (!fs.existsSync(p)) return 0;
        return fs.readFileSync(p, 'utf8').split('\n').filter(l => l.trim()).length;
      } catch { return 0; }
    };
    return {
      console_count: countLines('console-logs.jsonl'),
      network_count: countLines('network-log.jsonl'),
      error_count: countLines('js-errors.jsonl'),
      perf_entries: countLines('performance-metrics.jsonl'),
      metric_samples: countLines('system-metrics.jsonl'),
    };
  } catch { return undefined; }
}

/**
 * Stop a running demo by PID.
 * Kills the process group and returns the final progress snapshot.
 */
async function stopDemo(args: StopDemoArgs): Promise<StopDemoResult> {
  const { pid } = args;

  let entry = demoRuns.get(pid);
  if (!entry) {
    loadPersistedDemoRuns();
    entry = demoRuns.get(pid);
  }

  if (!entry) {
    return {
      success: false,
      pid,
      message: `No demo run found for PID ${pid}.`,
    };
  }

  // ── Remote demo stop ──
  if (entry.remote && entry.fly_machine_id) {
    try {
      const flyConfig = getFlyConfigFromServices();
      if (flyConfig) {
        const { resolved: flyResolved } = resolveOpReferencesStrict({ FLY_API_TOKEN: flyConfig.apiToken });
        const { stopRemoteMachine } = await import('./fly-runner.js');
        await stopRemoteMachine(
          { machineId: entry.fly_machine_id, appName: entry.fly_app_name || flyConfig.appName, region: flyConfig.region || 'iad', startedAt: new Date(entry.started_at).getTime() },
          { apiToken: flyResolved['FLY_API_TOKEN'], appName: flyConfig.appName, region: flyConfig.region || 'iad', machineSize: flyConfig.machineSize || 'shared-cpu-2x', machineRam: readFlyMachineConfig().machineRamHeadless, maxConcurrentMachines: flyConfig.maxConcurrentMachines || 3, projectImageEnabled: flyConfig.projectImageEnabled },
        );
      }
    } catch (e) {
      process.stderr.write(`[fly-runner] Failed to stop remote machine: ${e instanceof Error ? e.message : String(e)}\n`);
    }
    // Release Steel session if this was a Steel-backed run
    if (entry.steel_session_id) {
      try {
        const { releaseSteelSession } = await import('./steel-runner.js');
        const steelSection = getSteelConfigFromServices();
        if (steelSection) {
          const { resolved } = resolveOpReferencesStrict({ STEEL_API_KEY: steelSection.apiKey });
          if (resolved['STEEL_API_KEY']) {
            await releaseSteelSession({ apiKey: resolved['STEEL_API_KEY'], orgId: steelSection.orgId }, entry.steel_session_id);
          }
        }
      } catch { /* non-fatal — Steel sessions auto-expire */ }
    }
    const entryWithInterval = entry as DemoRunState & { _remotePollInterval?: ReturnType<typeof setInterval> };
    if (entryWithInterval._remotePollInterval) clearInterval(entryWithInterval._remotePollInterval);

    // Persist demo result to user-feedback.db (remote stop is always 'failed' with 'stopped' reason)
    if (entry.scenario_id && !entry.result_persisted) {
      persistDemoResult({
        scenarioId: entry.scenario_id,
        status: 'failed',
        executionMode: 'remote',
        startedAt: entry.started_at,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - new Date(entry.started_at).getTime(),
        flyMachineId: entry.fly_machine_id,
        branch: getDemoBranch() ?? undefined,
        failureReason: 'stopped',
      });
      entry.result_persisted = true;
    }

    demoRuns.delete(pid);
    persistDemoRuns();
    const stopMsg = entry.steel_session_id
      ? `Steel session ${entry.steel_session_id} released + Fly.io machine ${entry.fly_machine_id} stopped.`
      : `Remote Fly.io machine ${entry.fly_machine_id} stopped.`;
    return { success: true, pid, project: entry.project, message: stopMsg };
  }

  // Guard: only stop running or interrupted demos
  if (entry.status !== 'running' && entry.status !== 'interrupted') {
    return {
      success: false,
      pid,
      project: entry.project,
      message: `Demo is not running (status: ${entry.status}).`,
    };
  }

  const wasInterrupted = entry.status === 'interrupted';

  // Verify process is still alive before killing (prevents PID recycling issues)
  try {
    process.kill(pid, 0);
  } catch {
    // Stop window recorder — skip persistence for interrupted demos (discard recording)
    if (entry.window_recorder_pid && entry.window_recording_path) {
      const recOk = stopWindowRecorderSync(entry.window_recorder_pid, entry.window_recording_path);
      if (recOk && entry.scenario_id && !wasInterrupted) {
        try { persistScenarioRecording(entry.scenario_id, entry.window_recording_path); } catch { /* Non-fatal */ }
      }
      try { fs.unlinkSync(entry.window_recording_path); } catch { /* Non-fatal */ }
      entry.window_recorder_pid = undefined;
      entry.window_recording_path = undefined;
    }

    // Stop screenshot capture
    if (entry.screenshot_interval) {
      stopScreenshotCapture(entry.screenshot_interval);
      entry.screenshot_interval = undefined;
    }

    if (!wasInterrupted) {
      entry.status = 'unknown';
    }
    entry.ended_at = new Date().toISOString();

    // Resume task if this was an interrupted demo with a bypass request
    if (wasInterrupted) {
      resumeTaskAfterDemoInteraction(entry);
    }

    persistDemoRuns();
    return {
      success: wasInterrupted,
      pid,
      project: entry.project,
      message: wasInterrupted
        ? `Interrupted demo (PID ${pid}) cleaned up. Task resumed.`
        : `Demo process (PID ${pid}) is no longer running.`,
    };
  }

  // Clear poll tracking — manual stop takes over
  clearPollTracking(pid);

  // Read final progress snapshot before killing
  const progress = entry.progress_file ? readDemoProgress(entry.progress_file) : null;

  // Stop window recorder — skip persistence for interrupted demos (discard recording)
  if (entry.window_recorder_pid && entry.window_recording_path) {
    const recOk = stopWindowRecorderSync(entry.window_recorder_pid, entry.window_recording_path);
    if (recOk && entry.scenario_id && !wasInterrupted) {
      try { persistScenarioRecording(entry.scenario_id, entry.window_recording_path); } catch { /* Non-fatal */ }
    }
    try { fs.unlinkSync(entry.window_recording_path); } catch { /* Non-fatal */ }
    entry.window_recorder_pid = undefined;
    entry.window_recording_path = undefined;
  }

  // Stop screenshot capture
  if (entry.screenshot_interval) {
    stopScreenshotCapture(entry.screenshot_interval);
    entry.screenshot_interval = undefined;
  }

  // Kill the process group
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // Process may have already exited between check and kill
  }

  // Update demo run state
  if (!wasInterrupted) {
    entry.status = 'failed';
    entry.failure_summary = 'Manually stopped';
  }
  entry.ended_at = new Date().toISOString();

  // Resume task if this was an interrupted demo with a bypass request
  if (wasInterrupted) {
    resumeTaskAfterDemoInteraction(entry);
  }

  // Clean up progress file
  if (entry.progress_file) {
    try { fs.unlinkSync(entry.progress_file); } catch { /* Non-fatal */ }
  }

  // Persist demo result to user-feedback.db (dedup guard: only once per demo)
  if (entry.scenario_id && !entry.result_persisted && entry.status === 'failed') {
    persistDemoResult({
      scenarioId: entry.scenario_id,
      status: 'failed',
      executionMode: entry.remote ? 'remote' : 'local',
      startedAt: entry.started_at,
      completedAt: entry.ended_at ?? new Date().toISOString(),
      durationMs: entry.ended_at
        ? new Date(entry.ended_at).getTime() - new Date(entry.started_at).getTime()
        : Date.now() - new Date(entry.started_at).getTime(),
      flyMachineId: entry.fly_machine_id,
      branch: getDemoBranch() ?? undefined,
      failureReason: entry.failure_summary,
    });
    entry.result_persisted = true;
  }

  persistDemoRuns();

  // Auto-release display lock if this demo auto-acquired it — demo has been stopped
  autoReleaseDisplayLockForPid(pid);

  return {
    success: true,
    pid,
    project: entry.project,
    message: `Demo (PID ${pid}) stopped.${progress ? ` Final state: ${progress.tests_completed} tests completed (${progress.tests_passed} passed, ${progress.tests_failed} failed).` : ''}`,
    progress: progress ?? undefined,
  };
}

/**
 * Run E2E tests headlessly and return results.
 */
function runTests(args: RunTestsArgs): RunTestsResult {
  // Pre-flight validation
  const preflight = validatePrerequisites();
  if (!preflight.ok) {
    const projectLabel = args.project || 'default (vendor-owner + cross-persona)';
    return {
      success: false,
      project: projectLabel,
      passed: 0,
      failed: 0,
      skipped: 0,
      duration: '0s',
      output: `Environment validation failed:\n${preflight.errors.map(e => `  - ${e}`).join('\n')}`,
    };
  }

  // Clean up zombie dev servers from previous runs (use allocated ports in worktree context)
  cleanupDevServerPort(parseInt(process.env.PLAYWRIGHT_WEB_PORT || '3000', 10));
  cleanupDevServerPort(parseInt(process.env.PLAYWRIGHT_BACKEND_PORT || '3001', 10));

  const cmdArgs = ['playwright', 'test'];

  if (args.project) {
    cmdArgs.push('--project', args.project);
  }
  if (args.grep) {
    cmdArgs.push('--grep', args.grep);
  }
  if (args.retries !== undefined) {
    cmdArgs.push('--retries', String(args.retries));
  }
  if (args.workers !== undefined) {
    cmdArgs.push('--workers', String(args.workers));
  }
  if (args.timeout !== undefined) {
    cmdArgs.push('--timeout', String(args.timeout));
  }

  // Use list reporter for parseable output
  cmdArgs.push('--reporter', 'list');

  const projectLabel = args.project || 'default (vendor-owner + cross-persona)';

  try {
    const output = execFileSync('npx', cmdArgs, {
      cwd: EFFECTIVE_CWD,
      timeout: RUN_TIMEOUT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const { passed, failed, skipped, duration } = parseTestOutput(output);

    // Guard: zero tests executed is not a success
    if (passed === 0 && failed === 0 && skipped === 0) {
      return {
        success: false,
        project: projectLabel,
        passed: 0,
        failed: 0,
        skipped: 0,
        duration,
        output: truncateOutput(output),
        error: 'No tests were executed. Check project filter, test file paths, or Playwright configuration.',
      };
    }

    return {
      success: failed === 0,
      project: projectLabel,
      passed,
      failed,
      skipped,
      duration,
      output: truncateOutput(output),
    };
  } catch (err) {
    // execSync throws on non-zero exit code (test failures)
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    const output = (execErr.stdout || '') + (execErr.stderr || '');
    const { passed, failed, skipped, duration } = parseTestOutput(output);

    return {
      success: false,
      project: projectLabel,
      passed,
      failed: failed || 1, // At least 1 failure if we're in the catch
      skipped,
      duration,
      output: truncateOutput(output),
    };
  }
}

/**
 * Seed the E2E test database.
 */
function seedData(): SeedDataResult {
  // Pre-flight validation
  const preflight = validatePrerequisites();
  if (!preflight.ok) {
    return {
      success: false,
      message: `Environment validation failed:\n${preflight.errors.map(e => `  - ${e}`).join('\n')}`,
      output: '',
    };
  }

  // Clean up zombie dev servers from previous runs (use allocated ports in worktree context)
  cleanupDevServerPort(parseInt(process.env.PLAYWRIGHT_WEB_PORT || '3000', 10));
  cleanupDevServerPort(parseInt(process.env.PLAYWRIGHT_BACKEND_PORT || '3001', 10));

  try {
    const output = execFileSync('npx', ['playwright', 'test', '--project=seed'], {
      cwd: EFFECTIVE_CWD,
      timeout: RUN_TIMEOUT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return {
      success: true,
      message: 'Test database seeded successfully.',
      output: truncateOutput(output),
    };
  } catch (err) {
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    const output = (execErr.stdout || '') + (execErr.stderr || '');

    return {
      success: false,
      message: `Seeding failed: ${execErr.message || 'Unknown error'}`,
      output: truncateOutput(output),
    };
  }
}

/**
 * Clean up E2E test data.
 */
function cleanupData(): CleanupDataResult {
  // Pre-flight validation
  const preflight = validatePrerequisites();
  if (!preflight.ok) {
    return {
      success: false,
      message: `Environment validation failed:\n${preflight.errors.map(e => `  - ${e}`).join('\n')}`,
      output: '',
    };
  }

  // Clean up zombie dev servers from previous runs (use allocated ports in worktree context)
  cleanupDevServerPort(parseInt(process.env.PLAYWRIGHT_WEB_PORT || '3000', 10));
  cleanupDevServerPort(parseInt(process.env.PLAYWRIGHT_BACKEND_PORT || '3001', 10));

  try {
    const output = execFileSync('npx', ['playwright', 'test', '--project=seed'], {
      cwd: EFFECTIVE_CWD,
      timeout: RUN_TIMEOUT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, E2E_CLEANUP: 'true' },
    });

    return {
      success: true,
      message: 'Test data cleaned up successfully.',
      output: truncateOutput(output),
    };
  } catch (err) {
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    const output = (execErr.stdout || '') + (execErr.stderr || '');

    return {
      success: false,
      message: `Cleanup failed: ${execErr.message || 'Unknown error'}`,
      output: truncateOutput(output),
    };
  }
}

/**
 * Get the last Playwright test report.
 */
function getReport(args: GetReportArgs): GetReportResult {
  const reportIndex = path.join(REPORT_DIR, 'index.html');
  const exists = fs.existsSync(reportIndex);

  if (!exists) {
    return {
      success: true,
      reportPath: REPORT_DIR,
      exists: false,
      message: 'No test report found. Run tests first with run_tests.',
    };
  }

  const stats = fs.statSync(reportIndex);
  const lastModified = stats.mtime.toISOString();

  let browserOpened = false;
  let browserError: string | null = null;

  if (args.open_browser) {
    try {
      spawn('npx', ['playwright', 'show-report'], {
        detached: true,
        stdio: 'ignore',
        cwd: EFFECTIVE_CWD,
      }).unref();
      browserOpened = true;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      browserError = `Failed to open report in browser: ${errMsg}`;
      process.stderr.write(`[playwright] ${browserError}\n`);
    }
  }

  const statusMsg = args.open_browser
    ? (browserOpened
        ? `Report opened in browser. Last generated: ${lastModified}`
        : `Report exists but browser failed to open: ${browserError}. Last generated: ${lastModified}`)
    : `Report available at ${REPORT_DIR}. Last generated: ${lastModified}. Use open_browser: true to view.`;

  return {
    success: true,
    reportPath: REPORT_DIR,
    exists: true,
    lastModified,
    message: statusMsg,
  };
}

/**
 * Check E2E test coverage by persona and page.
 * Reads the filesystem to determine which projects have tests.
 * Projects are discovered dynamically from playwright.config.ts.
 */
function getCoverageStatus(): GetCoverageStatusResult {
  const personas: CoverageEntry[] = [];
  let totalTests = 0;
  let activeProjects = 0;
  let deferredProjects = 0;

  // Active test directories (discovered from playwright.config.ts)
  for (const [project, testDir] of Object.entries(pwConfig.projectDirMap)) {
    const fullDir = path.join(PROJECT_DIR, testDir);
    const testCount = countTestFiles(fullDir, project);

    const entry: CoverageEntry = {
      project,
      persona: pwConfig.personaMap[project] || project,
      testDir,
      testCount,
      status: testCount > 0 ? 'active' : 'no-tests',
    };

    if (testCount > 0) {
      activeProjects++;
      totalTests += testCount;
    }

    personas.push(entry);
  }

  // Deferred test directories: scan <defaultTestDir>/_deferred/ for subdirectories
  const deferredBase = path.join(PROJECT_DIR, pwConfig.defaultTestDir, '_deferred');
  if (fs.existsSync(deferredBase)) {
    try {
      const subdirs = fs.readdirSync(deferredBase, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

      for (const name of subdirs) {
        const testDir = path.join(pwConfig.defaultTestDir, '_deferred', name);
        const fullDir = path.join(PROJECT_DIR, testDir);
        const testCount = countTestFiles(fullDir);

        const personaLabel = name.charAt(0).toUpperCase() + name.slice(1).replace(/-/g, ' ');

        personas.push({
          project: `deferred-${name}`,
          persona: personaLabel,
          testDir,
          testCount,
          status: 'deferred',
        });

        if (testCount > 0) {
          deferredProjects++;
        }
      }
    } catch {
      // _deferred directory unreadable — skip
    }
  }

  return {
    personas,
    totalTests,
    activeProjects,
    deferredProjects,
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Count test files in a directory.
 * Matches *.spec.ts for automated tests, *.manual.ts for manual scaffolds.
 */
function countTestFiles(dir: string, projectFilter?: string): number {
  if (!fs.existsSync(dir)) return 0;

  const files = fs.readdirSync(dir, { recursive: true }) as string[];
  return files.filter(f => {
    const filename = String(f);
    const isSpec = filename.endsWith('.spec.ts');
    const isManual = filename.endsWith('.manual.ts');
    const isDemo = filename.endsWith('.demo.ts');
    if (!isSpec && !isManual && !isDemo) return false;

    // Exclude manual/ subdirectory for extension projects (counted separately as extension-manual)
    if (projectFilter) {
      const discovered = pwConfig.projects.find(p => p.name === projectFilter);
      if (discovered?.isExtension && !discovered.isManual && filename.includes('manual/')) return false;
    }

    return true;
  }).length;
}

// parseTestOutput and truncateOutput imported from ./helpers.js

/**
 * Open a video file in the system's default media player.
 */
function openVideo(args: OpenVideoArgs): OpenVideoResult {
  // Only allow relative paths — resolved from project dir
  if (path.isAbsolute(args.video_path)) {
    return {
      success: false,
      video_path: args.video_path,
      message: 'video_path must be a relative path (resolved from the project directory)',
    };
  }

  const videoPath = path.resolve(PROJECT_DIR, args.video_path);

  // Containment check: resolved path must be within PROJECT_DIR
  if (!videoPath.startsWith(PROJECT_DIR + path.sep) && videoPath !== PROJECT_DIR) {
    return {
      success: false,
      video_path: args.video_path,
      message: 'video_path resolves outside the project directory',
    };
  }

  if (!fs.existsSync(videoPath)) {
    return {
      success: false,
      video_path: videoPath,
      message: `Video file not found: ${videoPath}`,
    };
  }

  const ext = path.extname(videoPath).toLowerCase();
  if (!['.webm', '.mp4', '.avi', '.mov', '.mkv'].includes(ext)) {
    return {
      success: false,
      video_path: videoPath,
      message: `Unsupported video format: ${ext}. Expected .webm, .mp4, .avi, .mov, or .mkv`,
    };
  }

  try {
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(opener, [videoPath], { detached: true, stdio: 'ignore' }).unref();
    return {
      success: true,
      video_path: videoPath,
      message: `Opened ${path.basename(videoPath)} in default media player`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      video_path: videoPath,
      message: `Failed to open video: ${msg}`,
    };
  }
}

/**
 * Scan test-results/ and playwright-report/ for artifact files.
 * Returns paths to screenshots, videos, traces, and error context files.
 */
function scanArtifacts(maxEntries = 20): string[] {
  const artifacts: string[] = [];
  const dirs = [
    path.join(PROJECT_DIR, 'test-results'),
    path.join(PROJECT_DIR, 'playwright-report'),
  ];
  const extensions = new Set(['.png', '.webm', '.mp4', '.zip']);

  const walk = (dir: string, depth: number) => {
    if (depth > 4 || artifacts.length >= maxEntries) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (artifacts.length >= maxEntries) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(full, depth + 1);
        } else {
          const ext = path.extname(e.name).toLowerCase();
          if (extensions.has(ext) || e.name === 'error-context.md') {
            artifacts.push(full);
          }
        }
      }
    } catch {
      // Directory may not exist or be unreadable
    }
  };

  for (const dir of dirs) {
    walk(dir, 0);
  }

  return artifacts;
}

// ============================================================================
// Preflight Check
// ============================================================================

// Extension projects discovered from playwright.config.ts (names containing 'extension' or 'demo')

/**
 * Validate a Chrome extension match pattern per the Chrome docs spec.
 * <scheme>://<host>/<path> where host is * | *.domain | exact domain.
 * file:// has empty host (file:///path). No partial wildcards.
 */
function isValidChromeMatchPattern(pattern: string): boolean {
  if (pattern === '<all_urls>') return true;
  if (/^file:\/\/\/(.+)$/.test(pattern)) return true;
  const m = pattern.match(/^(\*|https?):\/\/([^/]+)\/(.*)$/);
  if (!m) return false;
  const host = m[2];
  if (host === '*') return true;
  if (host.startsWith('*.')) return !host.slice(2).includes('*');
  return !host.includes('*');
}

/**
 * Check if the dev server is reachable and healthy.
 */
async function checkDevServer(baseUrl: string): Promise<PreflightCheckEntry> {
  return new Promise<PreflightCheckEntry>((resolve) => {
    const start = Date.now();
    const url = new URL(baseUrl);
    const isHttps = url.protocol === 'https:';
    const httpModule = isHttps ? https : http;
    const req = httpModule.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'GET',
        timeout: 5000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          if (body.length < 16384) {
            body += chunk.toString('utf8').slice(0, 16384 - body.length);
          }
        });
        res.on('end', () => {
          const statusCode = res.statusCode ?? 0;

          if (statusCode >= 500) {
            const cleanBody = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
            resolve({
              name: 'dev_server',
              status: 'fail',
              message: `Dev server at ${baseUrl} returned HTTP ${statusCode}${cleanBody ? `: ${cleanBody}` : ''}`,
              duration_ms: Date.now() - start,
            });
            return;
          }

          // 403/401 typically means a non-app service is on this port (e.g., macOS AirPlay
          // Receiver on port 5000). A real dev server returns 200 or 3xx, not 403.
          if (statusCode === 403 || statusCode === 401) {
            resolve({
              name: 'dev_server',
              status: 'fail',
              message: `Dev server at ${baseUrl} returned HTTP ${statusCode} — this is likely NOT a dev server (macOS AirPlay Receiver or another service). Check port allocation.`,
              duration_ms: Date.now() - start,
            });
            return;
          }

          const errorPatterns = [
            'Unhandled Runtime Error',
            'Missing Supabase environment variables',
            'Internal Server Error',
          ];
          const bodyLower = body.toLowerCase();
          for (const pattern of errorPatterns) {
            if (bodyLower.includes(pattern.toLowerCase())) {
              const cleanBody = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
              resolve({
                name: 'dev_server',
                status: 'fail',
                message: `Dev server at ${baseUrl} responded but contains error: "${pattern}"${cleanBody ? ` — ${cleanBody}` : ''}`,
                duration_ms: Date.now() - start,
              });
              return;
            }
          }

          resolve({
            name: 'dev_server',
            status: 'pass',
            message: `Dev server at ${baseUrl} responded with ${statusCode}`,
            duration_ms: Date.now() - start,
          });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({
        name: 'dev_server',
        status: 'fail',
        message: `Dev server at ${baseUrl} did not respond within 5s`,
        duration_ms: Date.now() - start,
      });
    });
    req.on('error', () => {
      resolve({
        name: 'dev_server',
        status: 'fail',
        message: `Dev server at ${baseUrl} is not reachable`,
        duration_ms: Date.now() - start,
      });
    });
    req.end();
  });
}

/**
 * Poll a URL until it responds with a healthy status (2xx or 3xx).
 * Rejects 401/403 (likely a non-app service like macOS AirPlay) and 5xx.
 * @returns true if healthy within the timeout, false otherwise
 */
async function pollHealth(url: URL, timeoutMs: number = 30_000): Promise<boolean> {
  const isHttps = url.protocol === 'https:';
  const httpModule = isHttps ? https : http;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const ok = await new Promise<boolean>((resolve) => {
        const req = httpModule.request(
          { hostname: url.hostname, port: url.port || (isHttps ? 443 : 80), path: '/', method: 'GET', timeout: 3000 },
          (res) => {
            res.resume();
            const code = res.statusCode ?? 0;
            resolve(code >= 200 && code < 400);
          }
        );
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end();
      });
      if (ok) return true;
    } catch {
      // continue polling
    }
  }
  return false;
}

/**
 * Start dev services from services.json devServices config.
 * Mirrors secret_dev_server_start behavior: reads service filter/command/port,
 * applies worktree port overrides, and spawns detached processes with secrets.
 *
 * @returns Descriptive message on success, null on failure
 */
async function startDevServicesFromConfig(
  config: ReturnType<typeof loadServicesConfig>,
  childEnv: Record<string, string>,
  primaryUrl: URL,
): Promise<string | null> {
  const devServices = config.devServices;
  if (!devServices || Object.keys(devServices).length === 0) return null;

  const serviceEntries = Object.entries(devServices);
  const startedPids: Array<{ name: string; pid: number; port: number }> = [];
  const healthUrls: URL[] = [];

  // Known name patterns for port override mapping
  const webNames = new Set(['web', 'app', 'frontend', 'client', 'next', 'vite']);
  const backendNames = new Set(['backend', 'api', 'server', 'service']);

  for (const [name, svc] of serviceEntries) {
    const svcConfig = svc as { filter?: string; command?: string; port?: number; label?: string };
    if (!svcConfig.filter || !svcConfig.command) continue;

    // Determine port: worktree override > config > 0 (no port set)
    let port = svcConfig.port ?? 0;
    const nameLower = name.toLowerCase();
    if (process.env.PLAYWRIGHT_WEB_PORT && (webNames.has(nameLower) || serviceEntries.indexOf([name, svc]) === 0)) {
      port = parseInt(process.env.PLAYWRIGHT_WEB_PORT, 10);
    } else if (process.env.PLAYWRIGHT_BACKEND_PORT && backendNames.has(nameLower)) {
      port = parseInt(process.env.PLAYWRIGHT_BACKEND_PORT, 10);
    }

    const svcEnv = { ...childEnv };
    if (port > 0) svcEnv.PORT = String(port);

    try {
      const child = spawn('pnpm', ['--filter', svcConfig.filter, 'run', svcConfig.command], {
        detached: true,
        stdio: 'ignore',
        cwd: EFFECTIVE_CWD,
        env: svcEnv,
      });
      child.unref();
      if (!child.pid) continue;

      startedPids.push({ name, pid: child.pid, port });
      if (port > 0) {
        healthUrls.push(new URL(`http://localhost:${port}`));
      }
    } catch {
      // Non-fatal — try other services
    }
  }

  if (startedPids.length === 0) return null;

  // Poll health on the primary URL (the one run_demo needs)
  const healthy = await pollHealth(primaryUrl, 30_000);

  if (!healthy) {
    // Kill orphaned processes
    for (const { pid } of startedPids) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
    }
    return null;
  }

  const details = startedPids.map(s => `${s.name}:${s.port}(pid ${s.pid})`).join(', ');
  return `Dev services auto-started from services.json: ${details}`;
}

/**
 * Attempt to auto-start the dev server.
 *
 * Strategy (in order):
 * 1. Read services.json devServices — start ALL configured services with correct
 *    filter/command/port, matching secret_dev_server_start behavior.
 * 2. Fallback: single-process `pnpm run dev` for projects without devServices config.
 *
 * Secrets are resolved from 1Password and injected into child process env.
 * PORT is set from the baseUrl (which uses PLAYWRIGHT_WEB_PORT in worktree context).
 *
 * @returns Descriptive message on success, null on failure
 */
async function attemptDevServerAutoStart(baseUrl: string): Promise<string | null> {
  const url = new URL(baseUrl);
  const port = url.port || '3000';

  // Build env with secrets if available (non-fatal)
  let childEnv: Record<string, string>;
  let config: ReturnType<typeof loadServicesConfig> | null = null;
  try {
    config = loadServicesConfig(PROJECT_DIR);
    const { resolvedEnv } = resolveLocalSecrets(config);
    childEnv = buildCleanEnv(resolvedEnv);
  } catch {
    childEnv = buildCleanEnv();
  }

  // Strategy 1: Start from services.json devServices (multi-service support)
  if (config?.devServices && Object.keys(config.devServices).length > 0) {
    const result = await startDevServicesFromConfig(config, childEnv, url);
    if (result) return result;
    // Fall through to simple pnpm dev if devServices start failed
  }

  // Strategy 2: Fallback — single-process pnpm run dev
  childEnv.PORT = port;
  let childPid: number;
  try {
    const child = spawn('pnpm', ['run', 'dev'], {
      detached: true,
      stdio: 'ignore',
      cwd: EFFECTIVE_CWD,
      env: childEnv,
    });
    child.unref();
    if (!child.pid) return null;
    childPid = child.pid;
  } catch {
    return null;
  }

  const healthy = await pollHealth(url, 30_000);
  if (healthy) return `Dev server auto-started on port ${port} (pid ${childPid})`;

  // Health polling exhausted — kill the orphaned process
  try { process.kill(childPid, 'SIGTERM'); } catch { /* already dead */ }
  return null;
}

/**
 * Ensure the dev server is healthy before demo execution.
 * Checks health first; if not reachable, auto-starts.
 */
async function ensureDevServer(baseUrl?: string): Promise<{ ready: boolean; message: string }> {
  if (!baseUrl) baseUrl = `http://localhost:${process.env.PLAYWRIGHT_WEB_PORT || '3000'}`;
  const health = await checkDevServer(baseUrl);
  if (health.status === 'pass') return { ready: true, message: 'Dev server healthy' };

  // If not reachable, attempt auto-start
  if (health.message.includes('not reachable') || health.message.includes('did not respond')) {
    const result = await attemptDevServerAutoStart(baseUrl);
    if (result) return { ready: true, message: result };
    return { ready: false, message: `Dev server auto-start failed for ${baseUrl}. Register a dev server prerequisite: register_prerequisite({ command: "pnpm dev", scope: "global", run_as_background: true, health_check: "curl -sf http://localhost:\${PORT:-3000}" }). Use \${PORT:-3000} (not hardcoded ports) for worktree compatibility.` };
  }

  // HTTP error or app-level error
  return { ready: false, message: `Dev server unhealthy: ${health.message}` };
}

/**
 * Run a single preflight check and return a structured entry.
 */
function runCheck(
  name: string,
  fn: () => { status: 'pass' | 'fail' | 'warn' | 'skip'; message: string }
): PreflightCheckEntry {
  const start = Date.now();
  try {
    const result = fn();
    return { name, ...result, duration_ms: Date.now() - start };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { name, status: 'fail', message: `Unexpected error: ${message}`, duration_ms: Date.now() - start };
  }
}

/**
 * Walk a directory tree and return the newest mtime (in ms) among files
 * matching the given extensions. Returns null if no matching files found.
 */
function newestMtime(dir: string, extensions: Set<string>, maxDepth: number = 5): number | null {
  let newest: number | null = null;
  function walk(current: string, depth: number) {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (extensions.has(path.extname(entry.name))) {
        try {
          const mtime = fs.statSync(full).mtimeMs;
          if (newest === null || mtime > newest) newest = mtime;
        } catch { /* skip unreadable files */ }
      }
    }
  }
  walk(dir, 0);
  return newest;
}

/**
 * Comprehensive pre-flight validation before launching Playwright.
 * Checks config, deps, browsers, test files, credentials, compilation, and dev server.
 */
async function preflightCheck(args: PreflightCheckArgs): Promise<PreflightCheckResult> {
  const startTime = Date.now();
  const checks: PreflightCheckEntry[] = [];
  const failures: string[] = [];
  const warnings: string[] = [];
  const recoverySteps: string[] = [];

  // 0. Worktree freshness (auto-sync if possible — run FIRST so prerequisites run on fresh code)
  const preflightBaseUrl = args.base_url || `http://localhost:${process.env.PLAYWRIGHT_WEB_PORT || '3000'}`;
  if (WORKTREE_DIR) {
    const freshnessStart = Date.now();
    const freshness = checkAndSyncWorktree();
    if (freshness.fresh) {
      checks.push({ name: 'worktree_freshness', status: 'pass', message: 'Worktree is up to date with base branch', duration_ms: Date.now() - freshnessStart });
    } else {
      checks.push({ name: 'worktree_freshness', status: 'fail', message: freshness.message || 'Worktree is behind base branch', duration_ms: Date.now() - freshnessStart });
      failures.push(`Worktree freshness: ${freshness.message}`);
      recoverySteps.push('Commit any changes, then run: git fetch origin && git merge origin/preview --no-edit');
    }
  }

  // 0.5. Prerequisites (may start the dev server)
  const prereqStart = Date.now();
  try {
    const prereqResult = await executePrerequisites({ dry_run: false, base_url: preflightBaseUrl });
    if (prereqResult.success) {
      const msg = prereqResult.total === 0
        ? 'No prerequisites configured'
        : `${prereqResult.passed} executed, ${prereqResult.skipped} skipped (health check passed)`;
      checks.push({ name: 'prerequisites', status: prereqResult.total === 0 ? 'skip' : 'pass', message: msg, duration_ms: Date.now() - prereqStart });
    } else {
      checks.push({ name: 'prerequisites', status: 'fail', message: prereqResult.message, duration_ms: Date.now() - prereqStart });
      failures.push(`Prerequisites: ${prereqResult.message}`);
      const failedEntries = prereqResult.entries.filter(e => e.command_result === 'failed');
      for (const entry of failedEntries) {
        recoverySteps.push(`Fix prerequisite "${entry.description}": ${entry.error || 'unknown error'}`);
      }
    }
  } catch (err) {
    checks.push({ name: 'prerequisites', status: 'warn', message: `Could not run prerequisites: ${err instanceof Error ? err.message : String(err)}`, duration_ms: Date.now() - prereqStart });
    warnings.push(`Prerequisites check failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 1. Config exists
  checks.push(runCheck('config_exists', () => {
    const tsConfig = path.join(EFFECTIVE_CWD, 'playwright.config.ts');
    const jsConfig = path.join(EFFECTIVE_CWD, 'playwright.config.js');
    if (fs.existsSync(tsConfig)) {
      return { status: 'pass', message: `Found playwright.config.ts` };
    }
    if (fs.existsSync(jsConfig)) {
      return { status: 'pass', message: `Found playwright.config.js` };
    }
    return { status: 'fail', message: 'No playwright.config.ts or playwright.config.js found' };
  }));

  // 2. Dependencies installed (walks up directory tree for worktree compatibility)
  checks.push(runCheck('dependencies_installed', () => {
    // Walk up from EFFECTIVE_CWD to find @playwright/test (matches Node.js resolution)
    let depCheckDir: string | null = EFFECTIVE_CWD;
    let depsFound = false;
    while (depCheckDir) {
      const pwTestDir = path.join(depCheckDir, 'node_modules', '@playwright', 'test');
      if (fs.existsSync(pwTestDir)) { depsFound = true; break; }
      const parent = path.dirname(depCheckDir);
      if (parent === depCheckDir) break;
      depCheckDir = parent;
    }
    if (depsFound) {
      return { status: 'pass', message: '@playwright/test is installed' };
    }
    return { status: 'fail', message: '@playwright/test not found in node_modules (checked up to filesystem root)' };
  }));

  // 3. Browsers installed
  checks.push(runCheck('browsers_installed', () => {
    const homedir = os.homedir();
    const cacheLocations = [
      path.join(homedir, 'Library', 'Caches', 'ms-playwright'),
      path.join(homedir, '.cache', 'ms-playwright'),
    ];

    for (const cacheDir of cacheLocations) {
      if (!fs.existsSync(cacheDir)) continue;
      try {
        const entries = fs.readdirSync(cacheDir);
        const chromium = entries.find(e => e.startsWith('chromium-'));
        if (chromium) {
          return { status: 'pass', message: `Chromium found in ${cacheDir}` };
        }
      } catch {
        continue;
      }
    }
    return { status: 'fail', message: 'No Chromium browser found in Playwright cache' };
  }));

  // 4. Test files exist (when project specified)
  if (args.project) {
    checks.push(runCheck('test_files_exist', () => {
      const testDir = pwConfig.projectDirMap[args.project!];
      if (!testDir) {
        return { status: 'skip', message: `No known test directory mapping for project "${args.project}" — compilation check (#6) will validate it` };
      }

      const fullDir = path.join(EFFECTIVE_CWD, testDir);
      const count = countTestFiles(fullDir, args.project);
      if (count > 0) {
        return { status: 'pass', message: `${count} test file(s) found in ${testDir}` };
      }
      return { status: 'fail', message: `No test files found in ${testDir} for project "${args.project}"` };
    }));
  } else {
    checks.push({ name: 'test_files_exist', status: 'skip', message: 'No project specified — skipping test file check', duration_ms: 0 });
  }

  // 5. Credentials valid
  checks.push(runCheck('credentials_valid', () => {
    const preflight = validatePrerequisites();
    if (preflight.ok) {
      const warnMsg = preflight.warnings.length > 0
        ? ` (${preflight.warnings.length} warning(s))`
        : '';
      return { status: 'pass', message: `All required credentials are set${warnMsg}` };
    }
    return { status: 'fail', message: preflight.errors.join('; ') };
  }));

  // 5b. 1Password connectivity check
  checks.push(runCheck('op_connectivity', () => {
    const token = process.env.OP_SERVICE_ACCOUNT_TOKEN;
    if (!token) {
      return { status: 'warn' as const, message: 'OP_SERVICE_ACCOUNT_TOKEN not set — op:// secret resolution will fail for scenarios using 1Password references' };
    }
    try {
      execFileSync('op', ['whoami'], {
        encoding: 'utf-8',
        timeout: 10000,
        env: { ...process.env as Record<string, string>, OP_SERVICE_ACCOUNT_TOKEN: token },
        stdio: 'pipe',
      });
      return { status: 'pass' as const, message: '1Password service account reachable' };
    } catch (err) {
      return { status: 'fail' as const, message: `1Password unreachable: ${err instanceof Error ? err.message : String(err)}` };
    }
  }));

  // 6. Compilation succeeds (unless skipped)
  if (!args.skip_compilation && args.project) {
    checks.push(runCheck('compilation', () => {
      try {
        const listArgs = ['playwright', 'test', '--list', '--project', args.project!];
        const output = execFileSync('npx', listArgs, {
          cwd: EFFECTIVE_CWD,
          timeout: 30_000,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          env: process.env as Record<string, string>,
        });

        // Check if any tests were listed
        const lines = output.trim().split('\n').filter(l => l.trim().length > 0);
        if (lines.length === 0) {
          return { status: 'fail', message: 'Compilation succeeded but no tests were listed' };
        }
        return { status: 'pass', message: `${lines.length} test(s) listed successfully` };
      } catch (err) {
        const execErr = err as { stderr?: string; message?: string };
        const stderr = (execErr.stderr || '').trim();
        const snippet = stderr.length > 300 ? stderr.slice(0, 300) + '...' : stderr;
        return { status: 'fail', message: `Compilation/list failed: ${snippet || execErr.message || 'unknown error'}` };
      }
    }));
  } else {
    const reason = args.skip_compilation ? 'skip_compilation=true' : 'no project specified';
    checks.push({ name: 'compilation', status: 'skip', message: `Skipped (${reason})`, duration_ms: 0 });
  }

  // 7. Dev server reachable (fail, not warn — if it's not up, demo will fail)
  // Prerequisites already ran above (step 0) so the dev server should be up if a prereq started it.
  const pfWebPort = process.env.PLAYWRIGHT_WEB_PORT || '3000';
  const baseUrl = args.base_url || `http://localhost:${pfWebPort}`;
  let devServerCheck = await checkDevServer(baseUrl);
  // Auto-start: only attempt on connection refused (not on HTTP 500 / error patterns)
  if (devServerCheck.status === 'fail' && devServerCheck.message.includes('is not reachable')) {
    const autoStartResult = await attemptDevServerAutoStart(baseUrl);
    if (autoStartResult) {
      // Re-check after auto-start
      devServerCheck = await checkDevServer(baseUrl);
      if (devServerCheck.status === 'pass') {
        devServerCheck.message = `${devServerCheck.message} (auto-started)`;
      }
    }
  }
  checks.push(devServerCheck);

  // 7b. WebServer URLs reachable (from playwright.config.ts webServer entries)
  if (pwConfig.webServers.length > 0) {
    const webServerUrls = pwConfig.webServers
      .map(ws => ws.url)
      .filter((url): url is string => url !== null);

    // Filter out URLs that match the base_url already checked above, and unparseable URLs
    const additionalUrls = webServerUrls.filter(url => {
      try {
        const wsUrl = new URL(url);
        const baseUrlParsed = new URL(baseUrl);
        // Skip if same host:port as the base URL
        return !(wsUrl.hostname === baseUrlParsed.hostname && wsUrl.port === baseUrlParsed.port);
      } catch {
        return false; // Skip malformed URLs — they'll fail in checkDevServer anyway
      }
    });

    for (const wsUrl of additionalUrls) {
      let wsCheck: PreflightCheckEntry;
      try {
        wsCheck = await checkDevServer(wsUrl);
      } catch {
        wsCheck = { name: 'web_server', status: 'fail', message: `WebServer URL "${wsUrl}" is malformed or unreachable`, duration_ms: 0 };
        checks.push(wsCheck);
        continue;
      }
      // Rename the check to distinguish from the main dev_server check
      wsCheck.name = 'web_server';
      if (wsCheck.status === 'pass') {
        wsCheck.message = `WebServer at ${wsUrl} is reachable`;
      } else {
        wsCheck.message = `WebServer at ${wsUrl} is not reachable — ${wsCheck.message}`;
      }
      checks.push(wsCheck);
    }
  }

  // 7c. Code freshness — warn if source files are newer than build output (Next.js)
  checks.push(runCheck('code_freshness', () => {
    const nextDir = path.join(PROJECT_DIR, '.next');
    if (!fs.existsSync(nextDir)) {
      return { status: 'skip', message: 'No .next/ directory found — code freshness check requires Next.js' };
    }

    const srcDir = path.join(PROJECT_DIR, 'src');
    const sourceDir = fs.existsSync(srcDir) ? srcDir : path.join(PROJECT_DIR, 'app');
    if (!fs.existsSync(sourceDir)) {
      return { status: 'skip', message: 'No src/ or app/ directory found — cannot determine source location' };
    }

    const sourceExts = new Set(['.ts', '.tsx', '.js', '.jsx']);
    const newestSource = newestMtime(sourceDir, sourceExts);
    if (newestSource === null) {
      return { status: 'skip', message: 'No source files found in source directory' };
    }

    // Check .next/static or .next/server for build artifacts
    const buildDirs = ['static', 'server'].map(d => path.join(nextDir, d));
    const buildExts = new Set(['.js', '.css', '.json']);
    let newestBuild: number | null = null;
    for (const bd of buildDirs) {
      if (!fs.existsSync(bd)) continue;
      const t = newestMtime(bd, buildExts, 3);
      if (t !== null && (newestBuild === null || t > newestBuild)) newestBuild = t;
    }

    if (newestBuild === null) {
      return { status: 'warn', message: 'Dev server may be serving stale code — .next/ build artifacts not found. Consider restarting the dev server.' };
    }

    const driftMs = newestSource - newestBuild;
    if (driftMs > 5000) {  // 5s grace for HMR in-progress
      const driftSec = Math.round(driftMs / 1000);
      return {
        status: 'warn',
        message: `Dev server may be serving stale code — source files modified ${driftSec}s after last build output. Consider restarting the dev server.`,
      };
    }

    return { status: 'pass', message: 'Source files are in sync with build output' };
  }));

  // 8. Auth state freshness (only when a project is specified)
  if (args.project) {
    checks.push(runCheck('auth_state', () => {
      const authDir = path.join(EFFECTIVE_CWD, '.auth');

      // Find primary auth file: from config discovery, or scan .auth/
      let primaryFilePath: string | null = null;
      if (pwConfig.primaryAuthFile) {
        primaryFilePath = path.join(PROJECT_DIR, pwConfig.primaryAuthFile);
      } else if (fs.existsSync(authDir)) {
        try {
          const files = fs.readdirSync(authDir).filter(f => f.endsWith('.json'));
          if (files.length > 0) {
            // Use the most recently modified
            const sorted = files
              .map(f => ({ f, mtime: fs.statSync(path.join(authDir, f)).mtimeMs }))
              .sort((a, b) => b.mtime - a.mtime);
            primaryFilePath = path.join(authDir, sorted[0].f);
          }
        } catch {
          // ignore
        }
      }

      if (!primaryFilePath || !fs.existsSync(primaryFilePath)) {
        // Fail-closed: if config declares storageState files, missing auth is a failure.
        // Skip only when the project genuinely has no auth files configured.
        if (pwConfig.authFiles.length > 0) {
          return {
            status: 'fail',
            message: `Auth state file missing — expected ${pwConfig.primaryAuthFile || '.auth/*.json'}. Run mcp__playwright__run_auth_setup`,
          };
        }
        return { status: 'skip', message: 'No auth state files configured in playwright.config' };
      }

      const primaryBasename = path.basename(primaryFilePath);
      const stat = fs.statSync(primaryFilePath);
      const ageMs = Date.now() - stat.mtimeMs;
      const ageHours = ageMs / (1000 * 60 * 60);

      // Check cookie expiry from inside the JSON
      try {
        const state = JSON.parse(fs.readFileSync(primaryFilePath, 'utf-8'));
        const cookies: Array<{ expires?: number }> = state.cookies || [];
        const now = Date.now() / 1000;
        const expired = cookies.filter(c => c.expires && c.expires > 0 && c.expires < now);
        if (expired.length > 0) {
          return { status: 'fail', message: `Auth cookies are expired (${expired.length} expired in .auth/${primaryBasename}) — run mcp__playwright__run_auth_setup` };
        }
      } catch {
        return { status: 'warn', message: `Could not parse .auth/${primaryBasename} (${ageHours.toFixed(1)}h old)` };
      }

      if (ageHours > 24) {
        return { status: 'fail', message: `.auth files are ${ageHours.toFixed(1)}h old — run mcp__playwright__run_auth_setup` };
      }
      if (ageHours > 4) {
        return { status: 'warn', message: `.auth files are ${ageHours.toFixed(1)}h old — may expire soon` };
      }
      return { status: 'pass', message: `.auth files are ${ageHours.toFixed(1)}h old — fresh` };
    }));
  } else {
    checks.push({ name: 'auth_state', status: 'skip', message: 'No project specified — skipping auth state check', duration_ms: 0 });
  }

  // 9. Extension manifest validation (only for extension projects)
  if (args.project && pwConfig.extensionProjects.has(args.project)) {
    checks.push(runCheck('extension_manifest', () => {
      let manifestPath: string | null = null;

      const distPath = process.env.GENTYR_EXTENSION_DIST_PATH;
      if (distPath) {
        // Explicit path: try manifest at dist path, then parent directory
        const primaryPath = path.join(PROJECT_DIR, distPath, 'manifest.json');
        const fallbackPath = path.join(PROJECT_DIR, path.dirname(distPath), 'manifest.json');
        if (fs.existsSync(primaryPath)) {
          manifestPath = primaryPath;
        } else if (fs.existsSync(fallbackPath)) {
          manifestPath = fallbackPath;
        }
        if (!manifestPath) {
          return { status: 'fail', message: `manifest.json not found at ${primaryPath} or ${fallbackPath}` };
        }
      } else {
        // Auto-discover: check common build output directories
        const candidates = ['dist/', 'build/', 'out/', 'extension/dist/', 'extension/build/'];
        for (const candidate of candidates) {
          const candidatePath = path.join(PROJECT_DIR, candidate, 'manifest.json');
          if (!fs.existsSync(candidatePath)) continue;
          // Verify it's a Chrome extension manifest (has content_scripts or background)
          try {
            const content = JSON.parse(fs.readFileSync(candidatePath, 'utf-8'));
            if (content.content_scripts || content.background) {
              manifestPath = candidatePath;
              break;
            }
          } catch {
            // Not valid JSON — skip
          }
        }
        if (!manifestPath) {
          return { status: 'skip', message: 'GENTYR_EXTENSION_DIST_PATH not set and no manifest.json auto-discovered in dist/, build/, out/, extension/dist/, extension/build/' };
        }
      }

      let manifest: { content_scripts?: Array<{ matches?: string[]; exclude_matches?: string[] }> };
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { status: 'fail', message: `Failed to parse ${manifestPath}: ${msg}` };
      }

      const invalidPatterns: string[] = [];
      const contentScripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
      for (let i = 0; i < contentScripts.length; i++) {
        const cs = contentScripts[i];
        if (!cs || typeof cs !== 'object') continue;
        const allPatterns: Array<[string, string]> = [
          ...((Array.isArray(cs.matches) ? cs.matches : []) as string[]).map(p => ['matches', p] as [string, string]),
          ...((Array.isArray(cs.exclude_matches) ? cs.exclude_matches : []) as string[]).map(p => ['exclude_matches', p] as [string, string]),
        ];
        for (const [field, pattern] of allPatterns) {
          if (typeof pattern === 'string' && !isValidChromeMatchPattern(pattern)) {
            invalidPatterns.push(`content_scripts[${i}].${field}: ${pattern}`);
          }
        }
      }

      if (invalidPatterns.length > 0) {
        return {
          status: 'fail',
          message: `Invalid match patterns in ${path.relative(PROJECT_DIR, manifestPath)}:\n${invalidPatterns.map(p => `  - ${p}`).join('\n')}`,
        };
      }

      const totalPatterns = contentScripts.reduce((sum, cs) => {
        if (!cs || typeof cs !== 'object') return sum;
        return sum + (Array.isArray(cs.matches) ? cs.matches.length : 0) + (Array.isArray(cs.exclude_matches) ? cs.exclude_matches.length : 0);
      }, 0);
      return { status: 'pass', message: `${totalPatterns} match pattern(s) validated in ${path.relative(PROJECT_DIR, manifestPath)}` };
    }));
  } else {
    checks.push({ name: 'extension_manifest', status: 'skip', message: args.project ? `Project "${args.project}" is not an extension project` : 'No project specified', duration_ms: 0 });
  }

  // Aggregate results
  for (const check of checks) {
    if (check.status === 'fail') {
      failures.push(`${check.name}: ${check.message}`);
    } else if (check.status === 'warn') {
      warnings.push(`${check.name}: ${check.message}`);
    }
  }

  // Generate recovery steps for failures
  for (const check of checks) {
    if (check.status !== 'fail') continue;
    switch (check.name) {
      case 'config_exists':
        recoverySteps.push('Create playwright.config.ts in the project root (see Playwright docs)');
        break;
      case 'dependencies_installed':
        recoverySteps.push('Run: pnpm add -D @playwright/test');
        break;
      case 'browsers_installed':
        recoverySteps.push('Run: npx playwright install chromium');
        break;
      case 'test_files_exist':
        recoverySteps.push(`Create test files in the expected directory for project "${args.project}"`);
        break;
      case 'credentials_valid':
        recoverySteps.push('Check 1Password credential injection — ensure all op:// references in MCP server env are resolved');
        break;
      case 'op_connectivity':
        recoverySteps.push('Set OP_SERVICE_ACCOUNT_TOKEN env var with a valid 1Password service account token, or run: npx gentyr sync to re-inject credentials');
        break;
      case 'compilation':
        recoverySteps.push('Fix TypeScript compilation errors — run: npx playwright test --list to see details');
        break;
      case 'auth_state':
        recoverySteps.push('Run: mcp__playwright__run_auth_setup() to refresh auth cookies');
        break;
      case 'dev_server':
        recoverySteps.push('Register the dev server as a prerequisite: register_prerequisite({ command: "pnpm dev", scope: "global", run_as_background: true, health_check: "curl -sf http://localhost:${PORT:-3000}" }). Use ${PORT:-3000} (not hardcoded ports) for worktree compatibility. If already registered, verify the health_check uses ${PORT:-3000}.');
        break;
      case 'web_server':
        recoverySteps.push(`Start the backend server — check the webServer entries in playwright.config.ts (${check.message})`);
        break;
      case 'extension_manifest':
        recoverySteps.push('Fix invalid match patterns in manifest.json — Chrome requires host to be * | *.domain.com | exact.domain.com (no partial wildcards like *-admin.example.com)');
        break;
      case 'code_freshness':
        recoverySteps.push('Restart the dev server to recompile source changes, or wait for HMR to complete');
        break;
    }
  }

  return {
    ready: failures.length === 0,
    project: args.project || null,
    checks,
    failures,
    warnings,
    recovery_steps: recoverySteps,
    total_duration_ms: Date.now() - startTime,
  };
}

// ============================================================================
// Auth Setup
// ============================================================================

/**
 * Refresh Playwright auth state by running seed + auth-setup projects.
 * Seeds test data first, then runs the auth-setup project to generate .auth/*.json files.
 */
async function runAuthSetup(args: RunAuthSetupArgs): Promise<RunAuthSetupResult> {
  const startTime = Date.now();
  const prereq = validatePrerequisites();
  if (!prereq.ok) {
    return {
      success: false,
      phases: [],
      auth_files_refreshed: [],
      total_duration_ms: 0,
      error: `Credential check failed: ${prereq.errors.join('; ')}`,
      output_summary: '',
    };
  }

  // Execute registered prerequisites (starts dev server if registered as background prereq)
  const authBaseUrl = `http://localhost:${process.env.PLAYWRIGHT_WEB_PORT || '3000'}`;
  const prereqResult = await executePrerequisites({ base_url: authBaseUrl });
  if (!prereqResult.success) {
    return {
      success: false,
      phases: [],
      auth_files_refreshed: [],
      total_duration_ms: Date.now() - startTime,
      error: `Prerequisites failed: ${prereqResult.message}`,
      output_summary: '',
    };
  }

  // Verify dev server is healthy (fallback auto-start if no prerequisite handled it)
  const devServer = await ensureDevServer(authBaseUrl);
  if (!devServer.ready) {
    return {
      success: false,
      phases: [],
      auth_files_refreshed: [],
      total_duration_ms: Date.now() - startTime,
      error: `Dev server not ready: ${devServer.message}`,
      output_summary: '',
    };
  }

  // Build env with secrets + PLAYWRIGHT_BASE_URL for seed/auth-setup
  let authEnv: Record<string, string> = { ...process.env as Record<string, string> };
  try {
    const config = loadServicesConfig(PROJECT_DIR);
    const { resolvedEnv } = resolveLocalSecrets(config);
    Object.assign(authEnv, resolvedEnv);
  } catch { /* non-fatal */ }
  authEnv['PLAYWRIGHT_BASE_URL'] = authBaseUrl;

  const phases: RunAuthSetupResult['phases'] = [];

  // Phase 1: Seed
  const seedStart = Date.now();
  try {
    execFileSync('npx', ['playwright', 'test', '--project=seed'], {
      cwd: EFFECTIVE_CWD,
      timeout: 60_000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: authEnv,
    });
    phases.push({ name: 'seed', success: true, message: 'Seed completed', duration_ms: Date.now() - seedStart });
  } catch (err) {
    const execErr = err as { stderr?: string; message?: string };
    const msg = (execErr.stderr || execErr.message || 'unknown').slice(0, 300);
    phases.push({ name: 'seed', success: false, message: `Seed failed: ${msg}`, duration_ms: Date.now() - seedStart });
    return {
      success: false,
      phases,
      auth_files_refreshed: [],
      total_duration_ms: Date.now() - startTime,
      error: 'Seed phase failed — auth-setup aborted',
      output_summary: msg.slice(0, 500),
    };
  }

  if (args.seed_only) {
    return {
      success: true,
      phases,
      auth_files_refreshed: [],
      total_duration_ms: Date.now() - startTime,
      output_summary: 'Seed only',
    };
  }

  // Phase 2: Auth setup
  const authStart = Date.now();
  try {
    const output = execFileSync('npx', ['playwright', 'test', '--project=auth-setup'], {
      cwd: EFFECTIVE_CWD,
      timeout: 240_000, // 4 min: web server startup + 4 persona sign-ins
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: authEnv,
    });
    phases.push({ name: 'auth-setup', success: true, message: 'Auth setup completed', duration_ms: Date.now() - authStart });

    const authDir = path.join(EFFECTIVE_CWD, '.auth');
    const expected = pwConfig.authFiles.length > 0
      ? pwConfig.authFiles.map(f => path.basename(f))
      : (fs.existsSync(authDir) ? fs.readdirSync(authDir).filter(f => f.endsWith('.json')) : []);
    const refreshed = expected.filter(f => fs.existsSync(path.join(authDir, f)));

    return {
      success: true,
      phases,
      auth_files_refreshed: refreshed,
      total_duration_ms: Date.now() - startTime,
      output_summary: truncateOutput(output, 1000),
    };
  } catch (err) {
    const execErr = err as { stderr?: string; stdout?: string; message?: string };
    const msg = ((execErr.stderr || '') + (execErr.stdout || '') || execErr.message || 'unknown').slice(0, 500);
    phases.push({ name: 'auth-setup', success: false, message: `Auth setup failed: ${msg.slice(0, 300)}`, duration_ms: Date.now() - authStart });
    return {
      success: false,
      phases,
      auth_files_refreshed: [],
      total_duration_ms: Date.now() - startTime,
      error: 'Auth setup phase failed',
      output_summary: msg,
    };
  }
}

/**
 * List all open tabs in the CDP-connected extension test browser.
 * Requires --remote-debugging-port to be exposed in the fixture.
 */
async function listExtensionTabs(args: ListExtensionTabsArgs): Promise<ListExtensionTabsResult> {
  const { port } = args;

  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: 'localhost',
        port,
        path: '/json',
        method: 'GET',
        timeout: 5000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            const raw = JSON.parse(data) as Array<{
              id: string;
              title: string;
              url: string;
              type: string;
            }>;
            const tabs: ExtensionTab[] = raw
              .filter(t => t.type === 'page' || t.type === 'background_page' || t.url.startsWith('chrome-extension://'))
              .map(t => ({ id: t.id, title: t.title, url: t.url, type: t.type }));
            resolve({
              success: true,
              tabs,
              message: `Found ${tabs.length} tab(s) in extension browser (port ${port})`,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            resolve({ success: false, tabs: [], message: `Failed to parse CDP response: ${msg}` });
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({
        success: false,
        tabs: [],
        message: `CDP endpoint at port ${port} did not respond within 5s. Is the extension browser running with --remote-debugging-port=${port}?`,
      });
    });
    req.on('error', () => {
      resolve({
        success: false,
        tabs: [],
        message: `Cannot connect to CDP endpoint at port ${port}. Launch extension tests first (mcp__playwright__launch_ui_mode with project "demo" or "extension-manual").`,
      });
    });
    req.end();
  });
}

/**
 * Take a screenshot of a specific tab in the CDP-connected extension test browser.
 * Returns a base64 PNG image for inline rendering in Claude Code.
 */
async function screenshotExtensionTab(args: ScreenshotExtensionTabArgs): Promise<ScreenshotExtensionTabResult> {
  const { port, url_pattern, tab_id } = args;

  // Step 1: List tabs
  const listResult = await listExtensionTabs({ port });
  if (!listResult.success || listResult.tabs.length === 0) {
    return {
      success: false,
      message: listResult.success
        ? `No tabs found in extension browser at port ${port}`
        : listResult.message,
    };
  }

  // Step 2: Find the target tab
  let targetTab: ExtensionTab | undefined;

  if (tab_id) {
    targetTab = listResult.tabs.find(t => t.id === tab_id);
    if (!targetTab) {
      return {
        success: false,
        message: `Tab with id "${tab_id}" not found. Available tabs: ${listResult.tabs.map(t => t.id).join(', ')}`,
      };
    }
  } else if (url_pattern) {
    targetTab = listResult.tabs.find(t => t.url.includes(url_pattern));
    if (!targetTab) {
      // Fall back to first tab
      targetTab = listResult.tabs[0];
    }
  } else {
    targetTab = listResult.tabs[0];
  }

  if (!targetTab) {
    return { success: false, message: 'No tab selected' };
  }

  const selectedTab = targetTab;

  // Step 3: Activate the tab via CDP HTTP endpoint
  await new Promise<void>((resolve) => {
    const req = http.request(
      { hostname: 'localhost', port, path: `/json/activate/${selectedTab.id}`, method: 'GET', timeout: 3000 },
      () => resolve()
    );
    req.on('error', () => resolve());
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.end();
  });

  // Step 4: Get WebSocket debugger URL for this tab
  const wsDebuggerUrl = await new Promise<string | null>((resolve) => {
    const req = http.request(
      { hostname: 'localhost', port, path: `/json`, method: 'GET', timeout: 5000 },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            const tabs = JSON.parse(data) as Array<{ id: string; webSocketDebuggerUrl?: string }>;
            const tab = tabs.find(t => t.id === selectedTab.id);
            resolve(tab?.webSocketDebuggerUrl ?? null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });

  if (!wsDebuggerUrl) {
    return {
      success: false,
      tab: selectedTab,
      message: `Failed to get WebSocket debugger URL for tab "${selectedTab.title}" (${selectedTab.url})`,
    };
  }

  // Step 5: Connect via raw WebSocket and capture screenshot via CDP Page.captureScreenshot
  const base64png = await new Promise<string | null>((resolve) => {
    const url = new URL(wsDebuggerUrl);
    const wsPort = parseInt(url.port || String(port));

    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.createConnection({ host: url.hostname, port: wsPort }, () => {
      const handshake = [
        `GET ${url.pathname} HTTP/1.1`,
        `Host: ${url.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n');
      socket.write(handshake);
    });

    let upgraded = false;
    let buffer = Buffer.alloc(0);

    socket.setTimeout(10000);
    socket.on('timeout', () => { socket.destroy(); resolve(null); });
    socket.on('error', () => resolve(null));

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (!upgraded) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        upgraded = true;
        buffer = buffer.slice(headerEnd + 4);

        // Send Page.captureScreenshot
        const msg = JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } });
        const msgBytes = Buffer.from(msg, 'utf8');
        const mask = crypto.randomBytes(4);

        // Build WebSocket frame: FIN=1, opcode=1 (text), MASK=1, payload length
        let headerBuf: Buffer;
        if (msgBytes.length < 126) {
          headerBuf = Buffer.alloc(6); // 2 bytes header + 4 bytes mask
          headerBuf[0] = 0x81;
          headerBuf[1] = 0x80 | msgBytes.length;
          mask.copy(headerBuf, 2);
        } else if (msgBytes.length < 65536) {
          headerBuf = Buffer.alloc(8); // 2 + 2 extended len + 4 mask
          headerBuf[0] = 0x81;
          headerBuf[1] = 0x80 | 126;
          headerBuf.writeUInt16BE(msgBytes.length, 2);
          mask.copy(headerBuf, 4);
        } else {
          headerBuf = Buffer.alloc(14); // 2 + 8 extended len + 4 mask
          headerBuf[0] = 0x81;
          headerBuf[1] = 0x80 | 127;
          headerBuf.writeBigUInt64BE(BigInt(msgBytes.length), 2);
          mask.copy(headerBuf, 10);
        }

        const maskedPayload = Buffer.alloc(msgBytes.length);
        for (let i = 0; i < msgBytes.length; i++) {
          maskedPayload[i] = msgBytes[i] ^ mask[i % 4];
        }

        socket.write(Buffer.concat([headerBuf, maskedPayload]));
        return;
      }

      // Parse incoming WebSocket frame(s) — may arrive in chunks
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 0x0f;

        if (opcode === 0x08) {
          // Connection close
          socket.destroy();
          resolve(null);
          return;
        }

        const isMasked = (buffer[1] & 0x80) !== 0;
        const payloadLenByte = buffer[1] & 0x7f;
        let headerLen = 2 + (isMasked ? 4 : 0);
        let actualLen = payloadLenByte;

        if (payloadLenByte === 126) {
          if (buffer.length < 4) return; // wait for more data
          actualLen = buffer.readUInt16BE(2);
          headerLen = 4 + (isMasked ? 4 : 0);
        } else if (payloadLenByte === 127) {
          if (buffer.length < 10) return; // wait for more data
          actualLen = Number(buffer.readBigUInt64BE(2));
          headerLen = 10 + (isMasked ? 4 : 0);
        }

        if (buffer.length < headerLen + actualLen) return; // wait for complete frame

        let payload = buffer.slice(headerLen, headerLen + actualLen);

        if (isMasked) {
          const maskOffset = headerLen - 4;
          const frameMask = buffer.slice(maskOffset, maskOffset + 4);
          const unmasked = Buffer.alloc(payload.length);
          for (let i = 0; i < payload.length; i++) {
            unmasked[i] = payload[i] ^ frameMask[i % 4];
          }
          payload = unmasked;
        }

        buffer = buffer.slice(headerLen + actualLen);

        try {
          const msgParsed = JSON.parse(payload.toString('utf8')) as { result?: { data?: string } };
          if (msgParsed.result?.data) {
            socket.destroy();
            resolve(msgParsed.result.data);
            return;
          }
        } catch {
          // Not valid JSON or not our message — continue reading
        }
      }
    });
  });

  if (!base64png) {
    return {
      success: false,
      tab: selectedTab,
      message: `Failed to capture screenshot of tab "${selectedTab.title}" (${selectedTab.url})`,
    };
  }

  return {
    success: true,
    tab: selectedTab,
    image: base64png,
    message: `Screenshot captured for tab "${selectedTab.title}" (${selectedTab.url})`,
  };
}

// ============================================================================
// Demo Batch Execution
// ============================================================================

const DEMO_BATCHES_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'demo-batches.json');
const demoBatches = new Map<string, DemoBatchState>();

function loadPersistedDemoBatches(): void {
  try {
    if (!fs.existsSync(DEMO_BATCHES_PATH)) return;
    const data = JSON.parse(fs.readFileSync(DEMO_BATCHES_PATH, 'utf-8'));
    if (Array.isArray(data)) {
      for (const entry of data) {
        if (entry.batch_id) demoBatches.set(entry.batch_id, entry);
      }
    }
  } catch {
    // State file corrupt or missing — start fresh
  }
}

function persistDemoBatches(): void {
  try {
    const stateDir = path.dirname(DEMO_BATCHES_PATH);
    if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
    const entries = [...demoBatches.values()]
      .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())
      .slice(0, 10);
    fs.writeFileSync(DEMO_BATCHES_PATH, JSON.stringify(entries, null, 2));
  } catch {
    // Non-fatal
  }
}

loadPersistedDemoBatches();

/**
 * Discover demo scenarios from user-feedback.db.
 * Returns scenarios matching the provided filters.
 */
function discoverScenarios(opts: {
  scenario_ids?: string[];
  persona_ids?: string[];
  category_filter?: string;
}): Array<{ id: string; title: string; test_file: string; persona_id?: string; env_vars?: Record<string, string>; credential_warnings?: string[] }> {
  const dbPath = getUserFeedbackDbPath();
  if (!fs.existsSync(dbPath)) return [];

  const db = new Database(dbPath, { readonly: true });
  try {
    // Check table exists
    const tableCheck = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='demo_scenarios'"
    ).get() as { name: string } | undefined;
    if (!tableCheck) return [];

    // Check if env_vars column exists
    let hasEnvVars = false;
    try { db.prepare('SELECT env_vars FROM demo_scenarios LIMIT 0').run(); hasEnvVars = true; } catch { /* column not yet migrated */ }

    let query = hasEnvVars
      ? 'SELECT id, title, test_file, persona_id, env_vars FROM demo_scenarios WHERE enabled = 1'
      : 'SELECT id, title, test_file, persona_id FROM demo_scenarios WHERE enabled = 1';
    const params: string[] = [];

    if (opts.scenario_ids?.length) {
      const placeholders = opts.scenario_ids.map(() => '?').join(',');
      query += ` AND id IN (${placeholders})`;
      params.push(...opts.scenario_ids);
    }

    if (opts.persona_ids?.length) {
      const placeholders = opts.persona_ids.map(() => '?').join(',');
      query += ` AND persona_id IN (${placeholders})`;
      params.push(...opts.persona_ids);
    }

    if (opts.category_filter) {
      query += ' AND category = ?';
      params.push(opts.category_filter);
    }

    query += ' ORDER BY sort_order ASC, title ASC';

    const rows = db.prepare(query).all(...params) as Array<{
      id: string; title: string; test_file: string; persona_id: string | null; env_vars?: string | null;
    }>;
    return rows.map(r => {
      let envVars: Record<string, string> | undefined;
      let credentialWarnings: string[] | undefined;
      if (r.env_vars) {
        try {
          const parsed = JSON.parse(r.env_vars) as Record<string, string>;
          const { resolved, failedKeys, failureDetails } = resolveOpReferencesStrict(parsed);
          envVars = resolved;
          if (failedKeys.length > 0) {
            credentialWarnings = failedKeys.map(k => `Failed to resolve credential ${k}: ${failureDetails[k] || 'unknown error'}`);
          }
        } catch { /* invalid JSON */ }
      }
      return {
        id: r.id,
        title: r.title,
        test_file: r.test_file,
        persona_id: r.persona_id ?? undefined,
        env_vars: envVars,
        ...(credentialWarnings ? { credential_warnings: credentialWarnings } : {}),
      };
    });
  } finally {
    db.close();
  }
}

/**
 * Execute demo scenarios on remote Fly.io machines in parallel.
 * Each scenario gets its own ephemeral machine. Concurrency limited by maxConcurrentMachines.
 */
async function runRemoteBatchSequence(
  state: DemoBatchState,
  args: RunDemoBatchArgs,
  remoteScenarioIds: Set<string>,
): Promise<void> {
  const flyConfig = getFlyConfigFromServices();
  if (!flyConfig || !flyConfig.appName || !flyConfig.apiToken) return;

  const { resolved: flyResolved, failedKeys } = resolveOpReferencesStrict({ FLY_API_TOKEN: flyConfig.apiToken });
  if (failedKeys.length > 0) return;

  const flyRunnerMod = await import('./fly-runner.js');
  // Read per-mode RAM config (state file, always writable, no sync needed)
  const batchRamConfig = readFlyMachineConfig();
  const batchEffectiveRam = args.headless ? batchRamConfig.machineRamHeadless : batchRamConfig.machineRamHeaded;
  const COMPUTE_SIZE_RAM = { standard: 4096, large: 8192 } as const;
  const baseMachineConfig = {
    apiToken: flyResolved['FLY_API_TOKEN'],
    appName: flyConfig.appName,
    region: flyConfig.region || 'iad',
    machineSize: flyConfig.machineSize || 'shared-cpu-2x',
    machineRam: batchEffectiveRam,
    maxConcurrentMachines: flyConfig.maxConcurrentMachines || 3,
    projectImageEnabled: flyConfig.projectImageEnabled,
  };

  const remoteEntries = state.scenarios.filter(s => remoteScenarioIds.has(s.scenario_id));

  // Batch-level deadline
  const batchDeadline = Date.now() + (args.batch_timeout ?? 1800000);
  const scenarioTimeoutMs = args.scenario_timeout ?? 600000;

  // ── Slot-based streaming execution model ──
  // Instead of processing in fixed chunks, we acquire slots from the shared
  // machine pool and launch scenarios as soon as slots are available. This
  // allows multiple concurrent batches from different MCP server instances
  // to coordinate without exceeding the Fly.io org machine limit.
  const pendingScenarios = remoteEntries.filter(s => s.status === 'pending');
  const runningPromises = new Map<string, Promise<void>>();

  while (pendingScenarios.length > 0 || runningPromises.size > 0) {
    if (state.status !== 'running') break;

    // Batch-level timeout check: if exceeded, skip remaining scenarios
    if (Date.now() >= batchDeadline) {
      if (pendingScenarios.length > 0) {
        process.stderr.write(`[fly-runner] Batch timeout reached — skipping remaining ${pendingScenarios.length} scenario(s)\n`);
        for (const s of pendingScenarios) {
          s.status = 'skipped';
          s.failure_summary = 'Skipped — batch timeout exceeded';
          state.progress.skipped++;
          state.progress.completed++;
        }
        pendingScenarios.length = 0;
        persistDemoBatches();
      }
      // Wait for any still-running promises to settle before breaking
      if (runningPromises.size > 0) {
        await Promise.allSettled(runningPromises.values());
      }
      break;
    }

    // Try to acquire slots for pending scenarios
    while (pendingScenarios.length > 0) {
      const nextScenario = pendingScenarios[0];
      const slot = machinePool.acquireSlot(state.batch_id, nextScenario.scenario_id, process.pid);
      if (!slot.acquired) {
        // At capacity — wait for running scenarios to finish and free slots
        break;
      }

      const batchScenario = pendingScenarios.shift()!;
      batchScenario.status = 'running';
      persistDemoBatches();

      // Launch scenario execution (non-blocking)
      const slotId = slot.slotId!;
      const promise = (async () => {

      try {
        // Build env for this scenario
        const remoteEnv: Record<string, string> = {};

        // Resolve scenario env_vars from DB
        try {
          const feedbackDbPath = getUserFeedbackDbPath();
          if (fs.existsSync(feedbackDbPath)) {
            const db = new Database(feedbackDbPath, { readonly: true });
            try {
              const row = db.prepare('SELECT env_vars FROM demo_scenarios WHERE id = ?')
                .get(batchScenario.scenario_id) as { env_vars: string | null } | undefined;
              if (row?.env_vars) {
                const envVars = JSON.parse(row.env_vars) as Record<string, string>;
                const { resolved, failedKeys: envFailed } = resolveOpReferencesStrict(envVars);
                if (envFailed.length === 0) Object.assign(remoteEnv, resolved);
              }
            } catch { /* non-fatal */ }
            db.close();
          }
        } catch { /* non-fatal */ }

        // Resolve secrets.local
        try {
          const servicesPath = path.join(PROJECT_DIR, '.claude', 'config', 'services.json');
          if (fs.existsSync(servicesPath)) {
            const services = JSON.parse(fs.readFileSync(servicesPath, 'utf-8'));
            if (services.secrets?.local) {
              const { resolved: lr, failedKeys: lf } = resolveOpReferencesStrict(services.secrets.local as Record<string, string>);
              if (lf.length === 0) Object.assign(remoteEnv, lr);
            }
            if (services.demoDevModeEnv) Object.assign(remoteEnv, services.demoDevModeEnv);
          }
        } catch { /* non-fatal */ }

        if (process.env.GITHUB_TOKEN) remoteEnv.GIT_AUTH_TOKEN = process.env.GITHUB_TOKEN;
        // Also map GITHUB_TOKEN from resolved secrets.local to GIT_AUTH_TOKEN
        // (remote-runner.sh expects GIT_AUTH_TOKEN for git credential helper)
        if (!remoteEnv.GIT_AUTH_TOKEN && remoteEnv.GITHUB_TOKEN) {
          remoteEnv.GIT_AUTH_TOKEN = remoteEnv.GITHUB_TOKEN;
        }

        // Git info
        let gitRemote = '', gitRef = 'main';
        try {
          gitRemote = execSync('git remote get-url origin', { cwd: EFFECTIVE_CWD, encoding: 'utf8', timeout: 5000 }).trim();
          // Convert SSH URLs to HTTPS for container compatibility (no SSH keys in Docker)
          if (gitRemote.startsWith('git@github.com:')) {
            gitRemote = gitRemote.replace('git@github.com:', 'https://github.com/');
          }
          gitRef = execSync('git rev-parse --abbrev-ref HEAD', { cwd: EFFECTIVE_CWD, encoding: 'utf8', timeout: 5000 }).trim();
          if (gitRef === 'HEAD') gitRef = execSync('git rev-parse HEAD', { cwd: EFFECTIVE_CWD, encoding: 'utf8', timeout: 5000 }).trim();
        } catch { /* non-fatal */ }

        // Ensure the branch exists on the remote — worktree branches are local-only until pushed
        if (gitRef && gitRef !== 'HEAD' && gitRef !== 'main' && gitRef !== 'preview') {
          try {
            const lsRemote = execSync(`git ls-remote --heads origin ${gitRef}`, { cwd: EFFECTIVE_CWD, encoding: 'utf8', timeout: 10000 }).trim();
            if (!lsRemote) {
              // Branch doesn't exist on remote — push it
              process.stderr.write(`[fly-runner] Batch: Branch '${gitRef}' not on remote — pushing before remote execution\n`);
              execSync(`git push -u origin HEAD:${gitRef}`, { cwd: EFFECTIVE_CWD, encoding: 'utf8', timeout: 30000, stdio: 'pipe' });
            }
          } catch (pushErr) {
            process.stderr.write(`[fly-runner] Batch: Branch push failed: ${pushErr instanceof Error ? pushErr.message : String(pushErr)}\n`);
            // Fall back to base branch if push fails
            try {
              const baseBranch = execSync('git ls-remote --heads origin preview', { cwd: EFFECTIVE_CWD, encoding: 'utf8', timeout: 5000 }).trim()
                ? 'preview' : 'main';
              process.stderr.write(`[fly-runner] Batch: Falling back to base branch: ${baseBranch}\n`);
              gitRef = baseBranch;
            } catch { /* keep original gitRef */ }
          }
        }

        // Dev server config
        let devServerCmd: string | undefined, devServerPort: number | undefined, devServerHealthCheck: string | undefined;
        try {
          const servicesPath = path.join(PROJECT_DIR, '.claude', 'config', 'services.json');
          if (fs.existsSync(servicesPath)) {
            const services = JSON.parse(fs.readFileSync(servicesPath, 'utf-8'));
            if (services.devServices) {
              const first = Object.values(services.devServices)[0] as { filter?: string; command?: string; port?: number } | undefined;
              if (first) {
                devServerCmd = first.filter ? `pnpm --filter ${first.filter} ${first.command || 'dev'}` : `pnpm ${first.command || 'dev'}`;
                devServerPort = first.port || 3000;
                devServerHealthCheck = `curl -sf http://localhost:${devServerPort}`;
              }
            }
          }
        } catch { /* non-fatal */ }

        // Resolve test file and compute_size from scenario
        let testFile = '';
        let scenarioComputeSize: string | null = null;
        try {
          const feedbackDbPath = getUserFeedbackDbPath();
          if (fs.existsSync(feedbackDbPath)) {
            const db = new Database(feedbackDbPath, { readonly: true });
            try {
              const row = db.prepare('SELECT test_file, compute_size FROM demo_scenarios WHERE id = ?')
                .get(batchScenario.scenario_id) as { test_file: string | null; compute_size: string | null } | undefined;
              if (row?.test_file) testFile = row.test_file;
              if (row?.compute_size) scenarioComputeSize = row.compute_size;
            } catch { /* */ }
            db.close();
          }
        } catch { /* non-fatal */ }

        // Per-scenario compute_size override: 'large' = 8192MB, otherwise use global default
        const scenarioRam = scenarioComputeSize === 'large' ? COMPUTE_SIZE_RAM.large : baseMachineConfig.machineRam;
        const scenarioMachineConfig = { ...baseMachineConfig, machineRam: scenarioRam };

        // Generate unique run ID for Tigris correlation (same format as run_demo)
        const batchScenarioSlug = (batchScenario.scenario_id || 'adhoc').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 30);
        const batchRunId = `dr-${batchScenarioSlug}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
        batchScenario.run_id = batchRunId;

        const handle = await flyRunnerMod.spawnRemoteMachine(scenarioMachineConfig, {
          gitRemote,
          gitRef,
          testFile,
          env: remoteEnv,
          timeout: args.timeout ?? 1800000,
          slowMo: args.slow_mo ?? 0,
          headless: args.headless,
          devServerCmd,
          devServerPort,
          devServerHealthCheck,
          scenarioId: batchScenario.scenario_id,
          runId: batchRunId,
          servicesJsonPath: path.join(PROJECT_DIR, '.claude', 'config', 'services.json'),
          batchId: state.batch_id,
        });

        // Track the actual Fly machine ID in the slot pool
        machinePool.updateSlotMachineId(slotId, handle.machineId);

        const scenarioStartedAt = Date.now();
        const scenarioDeadline = scenarioStartedAt + scenarioTimeoutMs;

        // Poll until machine stops — pull artifacts proactively when exit code is written
        const destDir = path.join(PROJECT_DIR, '.claude', 'state', `demo-remote-batch-${state.batch_id}-${batchScenario.scenario_id}`);
        fs.mkdirSync(destDir, { recursive: true });
        let batchArtifactsPulled = false;

        let scenarioTimedOut = false;
        // Incremental log capture: capture logs every 30s while the machine is alive
        // so that if it dies suddenly, the most recent 30s-old capture is in the artifact dir
        let lastLogCaptureAt = 0;
        while (Date.now() < scenarioDeadline && await flyRunnerMod.isMachineAlive(handle, scenarioMachineConfig)) {
          // Check if artifacts are ready (sentinel written AFTER artifacts are copied)
          let batchReady = false;
          try {
            await flyRunnerMod.execInMachine(handle, scenarioMachineConfig, ['cat', '/app/.artifacts-ready'], 5_000);
            batchReady = true;
          } catch {
            // Sentinel not found — try .exit-code fallback (old Docker image)
            try {
              const ecBuf = await flyRunnerMod.execInMachine(handle, scenarioMachineConfig, ['cat', '/app/.exit-code'], 5_000);
              if (ecBuf.toString('utf8').trim() !== '') {
                process.stderr.write('[fly-runner] Batch: .artifacts-ready not found, falling back to .exit-code with 15s delay\n');
                await new Promise(r => setTimeout(r, 15_000));
                batchReady = true;
              }
            } catch { /* neither file — still running */ }
          }
          if (batchReady) {
            // Capture logs NOW while machine is still alive — critical for fast scenarios (<30s)
            // that complete before the 30s incremental capture interval fires
            await flyRunnerMod.captureRunningMachineLogs(handle, scenarioMachineConfig, destDir).catch(() => {});
            // Demo done — pull artifacts now while machine is still alive
            process.stderr.write(`[fly-runner] Batch: artifacts ready, pulling proactively\n`);
            try { const r = await flyRunnerMod.pullRemoteArtifacts(handle, scenarioMachineConfig, destDir); batchArtifactsPulled = true; if (r.errors.length) process.stderr.write(`[fly-runner] Batch proactive pull errors: ${r.errors.join('; ')}\n`); }
            catch { /* non-fatal */ }
            break;
          }

          // Incremental log capture every 30 seconds — guarantees diagnostic data
          // even if the machine dies suddenly between polls. Each step is non-fatal
          // with 5s individual timeouts, so total overhead is < 15s.
          if (Date.now() - lastLogCaptureAt > 30_000) {
            await flyRunnerMod.captureRunningMachineLogs(handle, scenarioMachineConfig, destDir).catch(() => {});
            lastLogCaptureAt = Date.now();
          }

          await new Promise(r => setTimeout(r, 10_000));
          if (state.status !== 'running') {
            await flyRunnerMod.stopRemoteMachine(handle, scenarioMachineConfig).catch(() => {});
            batchScenario.status = 'skipped';
            persistDemoBatches();
            return;
          }
        }

        // Check if scenario timed out (deadline exceeded while machine was still alive)
        if (Date.now() >= scenarioDeadline && !batchArtifactsPulled) {
          scenarioTimedOut = true;
          const timeoutSec = Math.round(scenarioTimeoutMs / 1000);
          process.stderr.write(`[fly-runner] Batch: scenario ${batchScenario.scenario_id} timed out after ${timeoutSec}s — killing machine\n`);
          // Final log capture before killing — last chance to get diagnostics
          await flyRunnerMod.captureRunningMachineLogs(handle, scenarioMachineConfig, destDir).catch(() => {});
          await flyRunnerMod.stopRemoteMachine(handle, scenarioMachineConfig).catch(() => {});
          // Try to pull whatever artifacts exist before the machine is destroyed
          try { await flyRunnerMod.pullRemoteArtifacts(handle, scenarioMachineConfig, destDir); batchArtifactsPulled = true; } catch { /* non-fatal */ }
        }

        // Pull artifacts and parse results (fallback if proactive pull didn't happen)
        if (!batchArtifactsPulled) {
          try { const r = await flyRunnerMod.pullRemoteArtifacts(handle, scenarioMachineConfig, destDir); if (r.errors.length) process.stderr.write(`[fly-runner] Batch fallback pull errors: ${r.errors.join('; ')}\n`); }
          catch { /* non-fatal — machine may already be destroyed */ }
        }

        // ── Per-scenario diagnostic extraction (parity with single-demo check_demo_result) ──
        const scenarioDurationSeconds = Math.round((Date.now() - scenarioStartedAt) / 1000);
        batchScenario.duration_ms = Date.now() - scenarioStartedAt;

        // Handle scenario timeout (machine was killed by our deadline)
        if (scenarioTimedOut) {
          batchScenario.status = 'failed';
          batchScenario.failure_summary = `Scenario timed out after ${Math.round(scenarioTimeoutMs / 1000)}s`;
          batchScenario.failure_classification = 'timeout';
          batchScenario.failure_suggestion = 'Increase scenario_timeout or investigate why the demo is taking too long. Check prerequisites and dev server startup time.';
        } else {
          let exitCode = -1;
          try {
            const ecPath = path.join(destDir, 'exit-code');
            if (fs.existsSync(ecPath)) exitCode = parseInt(fs.readFileSync(ecPath, 'utf-8').trim(), 10);
          } catch { /* non-fatal */ }

          batchScenario.status = exitCode === 0 ? 'passed' : 'failed';

          if (exitCode !== 0) {
            // Read stderr and machine log for diagnostics
            let batchStderrTail = '';
            try {
              const stderrPath = path.join(destDir, 'stderr.log');
              if (fs.existsSync(stderrPath)) batchStderrTail = fs.readFileSync(stderrPath, 'utf-8').slice(-5000);
            } catch { /* non-fatal */ }

            let batchMachineLog = '';
            try {
              const machineLogPath = path.join(destDir, 'fly-machine.log');
              if (fs.existsSync(machineLogPath)) batchMachineLog = fs.readFileSync(machineLogPath, 'utf-8').slice(-3000);
            } catch { /* non-fatal */ }

            batchScenario.stderr_tail = batchStderrTail || undefined;
            batchScenario.fly_machine_log = batchMachineLog || undefined;

            // Run shared failure classifier
            const progress = readDemoProgress(path.join(destDir, 'progress.jsonl'));
            const batchClassification = classifyFailure({
              exitCode,
              stderrTail: batchStderrTail,
              machineLog: batchMachineLog,
              durationSeconds: scenarioDurationSeconds,
              computeSizeUsed: scenarioComputeSize || 'standard',
              scenarioId: batchScenario.scenario_id,
              progress,
            });

            batchScenario.failure_classification = batchClassification.classification;
            batchScenario.failure_suggestion = batchClassification.suggestion;
            batchScenario.failure_summary = batchClassification.reason;

            // Add Elastic query hint when Elastic is configured
            if (process.env.ELASTIC_CLOUD_ID || process.env.ELASTIC_ENDPOINT) {
              batchScenario.elastic_query_hint =
                `Query logs: mcp__elastic-logs__query_logs({ query: 'demo.run_id:"${batchRunId}"', index: 'logs-demo-telemetry-*' })`;
            }
          }
        }

        await flyRunnerMod.stopRemoteMachine(handle, scenarioMachineConfig).catch(() => {});

        // Persist demo result to user-feedback.db for each remote batch scenario (success path)
        if (batchScenario.status === 'passed' || batchScenario.status === 'failed') {
          const remoteBatchCompletedAt = new Date().toISOString();
          persistDemoResult({
            scenarioId: batchScenario.scenario_id,
            status: batchScenario.status,
            executionMode: 'remote',
            startedAt: state.started_at,
            completedAt: remoteBatchCompletedAt,
            durationMs: batchScenario.duration_ms ?? (new Date(remoteBatchCompletedAt).getTime() - new Date(state.started_at).getTime()),
            flyMachineId: handle.machineId,
            branch: getDemoBranch() ?? undefined,
            failureReason: batchScenario.failure_summary,
          });
        }

      } catch (err) {
        batchScenario.status = 'failed';
        batchScenario.failure_summary = err instanceof Error ? err.message : String(err);
        batchScenario.failure_classification = 'unknown';
        // Persist demo result to user-feedback.db for each remote batch scenario (error path)
        const remoteBatchErrorCompletedAt = new Date().toISOString();
        persistDemoResult({
          scenarioId: batchScenario.scenario_id,
          status: 'failed',
          executionMode: 'remote',
          startedAt: state.started_at,
          completedAt: remoteBatchErrorCompletedAt,
          durationMs: new Date(remoteBatchErrorCompletedAt).getTime() - new Date(state.started_at).getTime(),
          branch: getDemoBranch() ?? undefined,
          failureReason: batchScenario.failure_summary,
        });
      }

      // Update aggregate counters
      state.progress.completed++;
      if (batchScenario.status === 'passed') state.progress.passed++;
      else if (batchScenario.status === 'failed') state.progress.failed++;
      persistDemoBatches();

      if (args.stop_on_failure && state.progress.failed > 0) {
        state.status = 'failed';
      }
      })().finally(() => {
        machinePool.releaseSlot(slotId);
        runningPromises.delete(batchScenario.scenario_id);
      });
      runningPromises.set(batchScenario.scenario_id, promise);
    }

    // Wait for at least one running scenario to complete (frees a slot)
    if (runningPromises.size > 0) {
      await Promise.race(runningPromises.values());
    } else if (pendingScenarios.length > 0) {
      // All slots taken by other batches — wait briefly and retry
      process.stderr.write(`[fly-pool] All slots taken by other batches — waiting 5s before retrying\n`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  // ── Infra-failure retry phase ──
  const INFRA_CLASSIFICATIONS = new Set(['oom', 'timeout', 'startup_failure', 'external_kill']);
  const maxRetries = args.retry_infra_failures ?? 1;
  if (maxRetries > 0 && state.status === 'running') {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const retriable = state.scenarios.filter(s =>
        s.status === 'failed' && s.failure_classification != null && INFRA_CLASSIFICATIONS.has(s.failure_classification)
      );
      if (retriable.length === 0) break;

      // Batch-level deadline: abort retries if exceeded
      if (Date.now() >= batchDeadline) {
        process.stderr.write(`[batch] Retry phase aborted — batch timeout exceeded\n`);
        break;
      }

      process.stderr.write(`[batch] Retry ${attempt}/${maxRetries}: ${retriable.length} infra failure(s)\n`);

      for (const scenario of retriable) {
        if (state.status !== 'running') break;
        if (Date.now() >= batchDeadline) break;

        const originalFailure = scenario.failure_summary || 'unknown';
        const wasOom = scenario.failure_classification === 'oom';

        // Reset scenario for re-run
        scenario.status = 'running';
        scenario.failure_summary = undefined as any;
        scenario.failure_classification = undefined;
        scenario.failure_suggestion = undefined;
        scenario.stderr_tail = undefined;
        scenario.fly_machine_log = undefined;
        state.progress.failed--;
        state.progress.completed--;
        persistDemoBatches();

        try {
          // Build env (same as original — resolve scenario env_vars + secrets.local)
          const retryEnv: Record<string, string> = {};
          try {
            const feedbackDbPath = getUserFeedbackDbPath();
            if (fs.existsSync(feedbackDbPath)) {
              const db = new Database(feedbackDbPath, { readonly: true });
              try {
                const row = db.prepare('SELECT env_vars FROM demo_scenarios WHERE id = ?')
                  .get(scenario.scenario_id) as { env_vars: string | null } | undefined;
                if (row?.env_vars) {
                  const envVars = JSON.parse(row.env_vars) as Record<string, string>;
                  const { resolved, failedKeys: envFailed } = resolveOpReferencesStrict(envVars);
                  if (envFailed.length === 0) Object.assign(retryEnv, resolved);
                }
              } catch { /* non-fatal */ }
              db.close();
            }
          } catch { /* non-fatal */ }

          try {
            const servicesPath = path.join(PROJECT_DIR, '.claude', 'config', 'services.json');
            if (fs.existsSync(servicesPath)) {
              const services = JSON.parse(fs.readFileSync(servicesPath, 'utf-8'));
              if (services.secrets?.local) {
                const { resolved: lr, failedKeys: lf } = resolveOpReferencesStrict(services.secrets.local as Record<string, string>);
                if (lf.length === 0) Object.assign(retryEnv, lr);
              }
              if (services.demoDevModeEnv) Object.assign(retryEnv, services.demoDevModeEnv);
            }
          } catch { /* non-fatal */ }

          if (process.env.GITHUB_TOKEN) retryEnv.GIT_AUTH_TOKEN = process.env.GITHUB_TOKEN;
          if (!retryEnv.GIT_AUTH_TOKEN && retryEnv.GITHUB_TOKEN) {
            retryEnv.GIT_AUTH_TOKEN = retryEnv.GITHUB_TOKEN;
          }

          // Git info
          let gitRemote = '', gitRef = 'main';
          try {
            gitRemote = execSync('git remote get-url origin', { cwd: EFFECTIVE_CWD, encoding: 'utf8', timeout: 5000 }).trim();
            if (gitRemote.startsWith('git@github.com:')) {
              gitRemote = gitRemote.replace('git@github.com:', 'https://github.com/');
            }
            gitRef = execSync('git rev-parse --abbrev-ref HEAD', { cwd: EFFECTIVE_CWD, encoding: 'utf8', timeout: 5000 }).trim();
            if (gitRef === 'HEAD') gitRef = execSync('git rev-parse HEAD', { cwd: EFFECTIVE_CWD, encoding: 'utf8', timeout: 5000 }).trim();
          } catch { /* non-fatal */ }

          // Dev server config
          let devServerCmd: string | undefined, devServerPort: number | undefined, devServerHealthCheck: string | undefined;
          try {
            const servicesPath = path.join(PROJECT_DIR, '.claude', 'config', 'services.json');
            if (fs.existsSync(servicesPath)) {
              const services = JSON.parse(fs.readFileSync(servicesPath, 'utf-8'));
              if (services.devServices) {
                const first = Object.values(services.devServices)[0] as { filter?: string; command?: string; port?: number } | undefined;
                if (first) {
                  devServerCmd = first.filter ? `pnpm --filter ${first.filter} ${first.command || 'dev'}` : `pnpm ${first.command || 'dev'}`;
                  devServerPort = first.port || 3000;
                  devServerHealthCheck = `curl -sf http://localhost:${devServerPort}`;
                }
              }
            }
          } catch { /* non-fatal */ }

          // Resolve test file and compute_size from scenario DB
          let testFile = '';
          let scenarioComputeSize: string | null = null;
          try {
            const feedbackDbPath = getUserFeedbackDbPath();
            if (fs.existsSync(feedbackDbPath)) {
              const db = new Database(feedbackDbPath, { readonly: true });
              try {
                const row = db.prepare('SELECT test_file, compute_size FROM demo_scenarios WHERE id = ?')
                  .get(scenario.scenario_id) as { test_file: string | null; compute_size: string | null } | undefined;
                if (row?.test_file) testFile = row.test_file;
                if (row?.compute_size) scenarioComputeSize = row.compute_size;
              } catch { /* */ }
              db.close();
            }
          } catch { /* non-fatal */ }

          // For OOM retries, force 'large' compute size (8192MB)
          const retryRam = wasOom
            ? COMPUTE_SIZE_RAM.large
            : (scenarioComputeSize === 'large' ? COMPUTE_SIZE_RAM.large : baseMachineConfig.machineRam);
          const retryMachineConfig = { ...baseMachineConfig, machineRam: retryRam };

          // Generate new run ID for the retry
          const retryScenarioSlug = (scenario.scenario_id || 'adhoc').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 30);
          const retryRunId = `dr-${retryScenarioSlug}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
          scenario.run_id = retryRunId;

          const retryHandle = await flyRunnerMod.spawnRemoteMachine(retryMachineConfig, {
            gitRemote,
            gitRef,
            testFile,
            env: retryEnv,
            timeout: args.timeout ?? 1800000,
            slowMo: args.slow_mo ?? 0,
            headless: args.headless,
            devServerCmd,
            devServerPort,
            devServerHealthCheck,
            scenarioId: scenario.scenario_id,
            runId: retryRunId,
            servicesJsonPath: path.join(PROJECT_DIR, '.claude', 'config', 'services.json'),
            batchId: state.batch_id,
          });

          const retryStartedAt = Date.now();
          const retryDeadline = retryStartedAt + scenarioTimeoutMs;

          // Poll until machine stops — pull artifacts proactively
          const retryDestDir = path.join(PROJECT_DIR, '.claude', 'state', `demo-remote-batch-${state.batch_id}-${scenario.scenario_id}-retry${attempt}`);
          fs.mkdirSync(retryDestDir, { recursive: true });
          let retryArtifactsPulled = false;
          let retryTimedOut = false;
          let retryLastLogCaptureAt = 0;

          while (Date.now() < retryDeadline && await flyRunnerMod.isMachineAlive(retryHandle, retryMachineConfig)) {
            let retryReady = false;
            try {
              await flyRunnerMod.execInMachine(retryHandle, retryMachineConfig, ['cat', '/app/.artifacts-ready'], 5_000);
              retryReady = true;
            } catch {
              try {
                const ecBuf = await flyRunnerMod.execInMachine(retryHandle, retryMachineConfig, ['cat', '/app/.exit-code'], 5_000);
                if (ecBuf.toString('utf8').trim() !== '') {
                  await new Promise(r => setTimeout(r, 15_000));
                  retryReady = true;
                }
              } catch { /* still running */ }
            }
            if (retryReady) {
              try { const r = await flyRunnerMod.pullRemoteArtifacts(retryHandle, retryMachineConfig, retryDestDir); retryArtifactsPulled = true; if (r.errors.length) process.stderr.write(`[fly-runner] Retry pull errors: ${r.errors.join('; ')}\n`); }
              catch { /* non-fatal */ }
              break;
            }

            // Incremental log capture every 30 seconds during retry polling
            if (Date.now() - retryLastLogCaptureAt > 30_000) {
              await flyRunnerMod.captureRunningMachineLogs(retryHandle, retryMachineConfig, retryDestDir).catch(() => {});
              retryLastLogCaptureAt = Date.now();
            }

            await new Promise(r => setTimeout(r, 10_000));
            if (state.status !== 'running') {
              await flyRunnerMod.stopRemoteMachine(retryHandle, retryMachineConfig).catch(() => {});
              break;
            }
          }

          // Timeout check
          if (Date.now() >= retryDeadline && !retryArtifactsPulled) {
            retryTimedOut = true;
            process.stderr.write(`[fly-runner] Retry: scenario ${scenario.scenario_id} timed out — killing machine\n`);
            // Final log capture before killing — last chance to get diagnostics
            await flyRunnerMod.captureRunningMachineLogs(retryHandle, retryMachineConfig, retryDestDir).catch(() => {});
            await flyRunnerMod.stopRemoteMachine(retryHandle, retryMachineConfig).catch(() => {});
            try { await flyRunnerMod.pullRemoteArtifacts(retryHandle, retryMachineConfig, retryDestDir); retryArtifactsPulled = true; } catch { /* non-fatal */ }
          }

          // Fallback artifact pull
          if (!retryArtifactsPulled) {
            try { await flyRunnerMod.pullRemoteArtifacts(retryHandle, retryMachineConfig, retryDestDir); } catch { /* non-fatal */ }
          }

          // Parse results
          const retryDurationSeconds = Math.round((Date.now() - retryStartedAt) / 1000);
          scenario.duration_ms = Date.now() - retryStartedAt;

          if (retryTimedOut) {
            scenario.status = 'failed';
            scenario.failure_summary = `Scenario timed out after ${Math.round(scenarioTimeoutMs / 1000)}s (retry ${attempt})`;
            scenario.failure_classification = 'timeout';
            scenario.failure_suggestion = 'Increase scenario_timeout or investigate why the demo is taking too long.';
          } else {
            let exitCode = -1;
            try {
              const ecPath = path.join(retryDestDir, 'exit-code');
              if (fs.existsSync(ecPath)) exitCode = parseInt(fs.readFileSync(ecPath, 'utf-8').trim(), 10);
            } catch { /* non-fatal */ }

            scenario.status = exitCode === 0 ? 'passed' : 'failed';

            if (exitCode !== 0) {
              let retryStderrTail = '';
              try {
                const stderrPath = path.join(retryDestDir, 'stderr.log');
                if (fs.existsSync(stderrPath)) retryStderrTail = fs.readFileSync(stderrPath, 'utf-8').slice(-5000);
              } catch { /* non-fatal */ }

              let retryMachineLog = '';
              try {
                const machineLogPath = path.join(retryDestDir, 'fly-machine.log');
                if (fs.existsSync(machineLogPath)) retryMachineLog = fs.readFileSync(machineLogPath, 'utf-8').slice(-3000);
              } catch { /* non-fatal */ }

              scenario.stderr_tail = retryStderrTail || undefined;
              scenario.fly_machine_log = retryMachineLog || undefined;

              const retryProgress = readDemoProgress(path.join(retryDestDir, 'progress.jsonl'));
              const retryClassification = classifyFailure({
                exitCode,
                stderrTail: retryStderrTail,
                machineLog: retryMachineLog,
                durationSeconds: retryDurationSeconds,
                computeSizeUsed: wasOom ? 'large' : (scenarioComputeSize || 'standard'),
                scenarioId: scenario.scenario_id,
                progress: retryProgress,
              });

              scenario.failure_classification = retryClassification.classification;
              scenario.failure_suggestion = retryClassification.suggestion;
              scenario.failure_summary = retryClassification.reason;

              if (process.env.ELASTIC_CLOUD_ID || process.env.ELASTIC_ENDPOINT) {
                scenario.elastic_query_hint =
                  `Query logs: mcp__elastic-logs__query_logs({ query: 'demo.run_id:"${retryRunId}"', index: 'logs-demo-telemetry-*' })`;
              }
            }
          }

          await flyRunnerMod.stopRemoteMachine(retryHandle, retryMachineConfig).catch(() => {});

          // Persist demo result for the retry
          if (scenario.status === 'passed' || scenario.status === 'failed') {
            persistDemoResult({
              scenarioId: scenario.scenario_id,
              status: scenario.status,
              executionMode: 'remote',
              startedAt: new Date(retryStartedAt).toISOString(),
              completedAt: new Date().toISOString(),
              durationMs: scenario.duration_ms ?? 0,
              flyMachineId: retryHandle.machineId,
              branch: getDemoBranch() ?? undefined,
              failureReason: scenario.failure_summary,
            });
          }

        } catch (err) {
          scenario.status = 'failed';
          scenario.failure_summary = err instanceof Error ? err.message : String(err);
          scenario.failure_classification = 'unknown';
        }

        // Track the retry
        if (!state.retried_scenarios) state.retried_scenarios = [];
        state.retried_scenarios.push({
          scenario_id: scenario.scenario_id,
          original_failure: originalFailure,
          retry_result: scenario.status,
          retry_attempt: attempt,
          ...(wasOom ? { oom_upgraded: true } : {}),
        });

        // Update aggregate counters
        state.progress.completed++;
        if (scenario.status === 'passed') state.progress.passed++;
        else if (scenario.status === 'failed') state.progress.failed++;
        persistDemoBatches();
      }
    }
  }

  // ── Batch-completion cleanup: destroy all machines tagged with this batch_id ──
  try {
    const activeMachines = await flyRunnerMod.listActiveMachines(baseMachineConfig);
    const batchMachines = activeMachines.filter(m => m.metadata?.batch_id === state.batch_id);
    if (batchMachines.length > 0) {
      process.stderr.write(`[fly-runner] Batch cleanup: destroying ${batchMachines.length} remaining machine(s) for batch ${state.batch_id}\n`);
      await Promise.all(batchMachines.map(async (m) => {
        try {
          await flyRunnerMod.stopRemoteMachine(
            { machineId: m.id, appName: baseMachineConfig.appName, region: baseMachineConfig.region, startedAt: Date.now() },
            baseMachineConfig,
          );
        } catch { /* non-fatal — machine may already be destroyed */ }
      }));
    }
  } catch {
    // Non-fatal — machines will be cleaned up by the hourly stale machine cleanup
  }
}

/**
 * Run a batch of demo scenarios sequentially.
 * Each batch gets its own output directory to prevent Playwright's cleanup from destroying previous recordings.
 */
async function runBatchSequence(state: DemoBatchState, args: RunDemoBatchArgs, scenarioEnvMap?: Map<string, Record<string, string>>, devServerReady?: boolean, effectiveBaseUrl?: string): Promise<void> {
  const scenarios = state.scenarios;
  const batchSize = args.batch_size ?? scenarios.length; // Local batches: run all concurrently (no Fly machine limit)
  const totalBatches = Math.ceil(scenarios.length / batchSize);

  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    // Check if stopped
    if (state.status !== 'running') break;

    state.progress.current_batch = batchIdx + 1;
    const batchStart = batchIdx * batchSize;
    const batchEnd = Math.min(batchStart + batchSize, scenarios.length);
    // Only process pending scenarios — skip any already claimed by runRemoteBatchSequence
    const batchScenarios = scenarios.slice(batchStart, batchEnd).filter(s => s.status === 'pending');
    if (batchScenarios.length === 0) continue;

    // Mark batch scenarios as running
    for (const s of batchScenarios) s.status = 'running';
    state.progress.current_scenario = batchScenarios[0]?.scenario_title;
    persistDemoBatches();

    // Batch-specific output directory to prevent Playwright cleanup from destroying previous recordings
    const batchOutputDir = path.join(PROJECT_DIR, '.claude', 'state', `demo-batch-${state.batch_id}`, `batch-${batchIdx}`);
    fs.mkdirSync(batchOutputDir, { recursive: true });

    // Progress file for this batch
    const progressId = crypto.randomBytes(4).toString('hex');
    const progressFile = path.join(PROJECT_DIR, '.claude', 'state', `demo-batch-progress-${progressId}.jsonl`);
    state.current_progress_file = progressFile;

    // Union env_vars from all scenarios in this batch
    let batchEnvVars: Record<string, string> | undefined;
    if (scenarioEnvMap?.size) {
      for (const s of batchScenarios) {
        const ev = scenarioEnvMap.get(s.scenario_id);
        if (ev) {
          if (!batchEnvVars) batchEnvVars = {};
          Object.assign(batchEnvVars, ev);
        }
      }
    }

    // Build environment
    let env: Record<string, string>;
    try {
      env = buildDemoEnv({
        slow_mo: args.slow_mo,
        headless: args.headless,
        base_url: effectiveBaseUrl ?? args.base_url,
        trace: args.trace,
        progress_file: progressFile,
        extra_env: batchEnvVars,
        dev_server_ready: devServerReady,
      });
    } catch (err) {
      const errMsg = `Credential resolution failed: ${err instanceof Error ? err.message : String(err)}`;
      process.stderr.write(`[playwright] ${errMsg}\n`);
      for (const s of batchScenarios) { s.status = 'failed'; s.failure_summary = errMsg; }
      state.status = 'failed';
      persistDemoBatches();
      return;
    }

    // Build command args — include all test files in this batch
    const cmdArgs = ['playwright', 'test', '--project', args.project];
    // Insert test files BEFORE --project (Playwright treats post-project positional args as project names)
    const testFiles = batchScenarios.map(s => s.test_file);
    cmdArgs.splice(2, 0, ...testFiles);
    if (args.trace) cmdArgs.push('--trace', 'on');
    if (!args.headless) cmdArgs.push('--headed');
    cmdArgs.push('--timeout', String(args.timeout ?? 120000));
    cmdArgs.push('--output', batchOutputDir);

    // Spawn the batch process
    const batchSpawnedAt = Date.now();
    try {
      const exitResult = await new Promise<{ code: number | null; stderrChunks: Buffer[] }>((resolve) => {
        const stderrChunks: Buffer[] = [];
        const child = spawn('npx', cmdArgs, {
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: EFFECTIVE_CWD,
          env,
        });

        if (!child.pid) {
          resolve({ code: 1, stderrChunks });
          return;
        }

        state.current_pid = child.pid;
        persistDemoBatches();

        child.stdout?.resume();
        if (child.stderr) {
          child.stderr.on('data', (chunk: Buffer) => { stderrChunks.push(chunk); });
        }

        child.on('exit', (code) => {
          resolve({ code, stderrChunks });
        });

        child.on('error', () => {
          resolve({ code: 1, stderrChunks });
        });

        child.unref();
      });

      // Build per-file result map from the JSONL progress file (reads ALL events, not just last 5)
      const fileResultMap = new Map<string, 'passed' | 'failed'>();
      try {
        if (fs.existsSync(progressFile)) {
          const lines = fs.readFileSync(progressFile, 'utf-8').trim().split('\n').filter(Boolean);
          for (const line of lines) {
            try {
              const event = JSON.parse(line);
              if (event.type === 'test_end' && event.file) {
                const status = (event.status === 'failed' || event.status === 'timedOut') ? 'failed' : 'passed';
                // If any test in a file fails, the file is failed
                if (status === 'failed' || !fileResultMap.has(event.file)) {
                  fileResultMap.set(event.file, status);
                }
              }
            } catch { /* skip malformed lines */ }
          }
        }
      } catch { /* Non-fatal */ }

      const progress = readDemoProgress(progressFile);

      // Build stderr tail from captured chunks (shared across all scenarios in this batch)
      const batchStderrTail = Buffer.concat(exitResult.stderrChunks).toString('utf-8').trim().slice(-5000);
      const batchDurationMs = Date.now() - batchSpawnedAt;
      const batchDurationSeconds = Math.round(batchDurationMs / 1000);

      // Map results back to scenarios using per-file results
      for (const s of batchScenarios) {
        const fileResult = fileResultMap.get(path.basename(s.test_file));
        if (fileResult) {
          s.status = fileResult;
        } else {
          // No progress event for this file — use exit code as fallback
          s.status = exitResult.code === 0 ? 'passed' : 'failed';
        }

        // Track per-scenario duration (batch-level — all scenarios share one process)
        s.duration_ms = batchDurationMs;

        if (s.status === 'failed') {
          s.failure_summary = progress?.recent_errors?.[0]?.slice(0, 500) ?? `Exit code: ${exitResult.code}`;

          // Diagnostic enrichment: stderr, failure classification, elastic query hint
          if (batchStderrTail) {
            s.stderr_tail = batchStderrTail;
          }

          const classification = classifyFailure({
            exitCode: exitResult.code ?? 1,
            stderrTail: batchStderrTail,
            durationSeconds: batchDurationSeconds,
            scenarioId: s.scenario_id,
            progress,
          });
          s.failure_classification = classification.classification;
          s.failure_suggestion = classification.suggestion;
          // Override failure_summary with the classifier's reason (more informative than generic exit code)
          s.failure_summary = classification.reason;

          if (process.env.ELASTIC_CLOUD_ID || process.env.ELASTIC_ENDPOINT) {
            s.elastic_query_hint =
              `Query logs: mcp__elastic-logs__query_logs({ query: 'demo.scenario_id:"${s.scenario_id}"', index: 'logs-demo-telemetry-*' })`;
          }
        }

        // Persist demo result to user-feedback.db for each local batch scenario
        if (s.status === 'passed' || s.status === 'failed') {
          const localBatchCompletedAt = new Date().toISOString();
          persistDemoResult({
            scenarioId: s.scenario_id,
            status: s.status,
            executionMode: 'local',
            startedAt: state.started_at,
            completedAt: localBatchCompletedAt,
            durationMs: s.duration_ms ?? (new Date(localBatchCompletedAt).getTime() - new Date(state.started_at).getTime()),
            branch: getDemoBranch() ?? undefined,
            failureReason: s.failure_summary,
          });
        }

        // Update progress counters
        if (s.status === 'passed') state.progress.passed++;
        else if (s.status === 'failed') state.progress.failed++;
        state.progress.completed++;
      }

      // Clean up progress file
      try { fs.unlinkSync(progressFile); } catch { /* Non-fatal */ }

      persistDemoBatches();

      // Check stop_on_failure
      if (args.stop_on_failure && state.progress.failed > 0) {
        // Mark remaining scenarios as skipped
        for (const s of scenarios) {
          if (s.status === 'pending') {
            s.status = 'skipped';
            state.progress.skipped++;
          }
        }
        state.status = 'failed';
        state.ended_at = new Date().toISOString();
        persistDemoBatches();
        return;
      }
    } catch (err) {
      // Batch process failed to spawn
      for (const s of batchScenarios) {
        s.status = 'failed';
        s.failure_summary = err instanceof Error ? err.message : String(err);
        state.progress.failed++;
        state.progress.completed++;
      }
      persistDemoBatches();
    }
  }

  // All batches complete
  if (state.status === 'running') {
    state.status = state.progress.failed > 0 ? 'failed' : 'passed';
    state.ended_at = new Date().toISOString();
  }
  state.current_pid = undefined;
  state.current_progress_file = undefined;
  state.progress.current_scenario = undefined;

  // Clean up batch output directories
  try {
    const batchDir = path.join(PROJECT_DIR, '.claude', 'state', `demo-batch-${state.batch_id}`);
    if (fs.existsSync(batchDir)) {
      fs.rmSync(batchDir, { recursive: true, force: true });
    }
  } catch {
    // Non-fatal
  }

  persistDemoBatches();
}

/**
 * Start a batch demo run.
 * Discovers scenarios, partitions into batches, and runs them sequentially in the background.
 */
async function runDemoBatch(args: RunDemoBatchArgs): Promise<string> {
  // ── Spawned-session remote enforcement ──
  // Spawned agents MUST use remote Fly.io execution for batch demos too,
  // UNLESS the CTO approved a demo_local bypass request.
  const isBatchSpawnedSession = process.env.CLAUDE_SPAWNED_SESSION === 'true';
  if (isBatchSpawnedSession) {
    let hasBatchLocalBypass = false;
    try {
      const bypassDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'bypass-requests.db');
      if (fs.existsSync(bypassDbPath)) {
        const bypassDb = new Database(bypassDbPath, { readonly: true });
        try {
          const approval = bypassDb.prepare(
            "SELECT id FROM bypass_requests WHERE category = 'demo_local' AND status = 'approved' AND created_at > datetime('now', '-1 hour') LIMIT 1"
          ).get();
          if (approval) hasBatchLocalBypass = true;
        } finally { bypassDb.close(); }
      }
    } catch { /* non-fatal */ }

    if (!hasBatchLocalBypass) {
      const flyConfig = getFlyConfigFromServices();
      const flyAvailableForBatch = flyConfig !== null && flyConfig.enabled !== false && !!flyConfig.appName && !!flyConfig.apiToken;
      if (flyAvailableForBatch) {
        args.remote = true;
      } else {
        return JSON.stringify({
          error: 'Spawned agents are not allowed to run demos locally. Fly.io remote execution is required but not configured. ' +
            'Configure Fly.io via /setup-fly, or ask the CTO to run this demo from the live dashboard or an interactive session.',
        });
      }
    }
  }

  // All demos run headed with video recording. The headless parameter is
  // deprecated — force headed mode regardless of what the caller passed.
  args.headless = false;

  const batchWebPort = process.env.PLAYWRIGHT_WEB_PORT || '3000';
  const devServerUrl = args.base_url || `http://localhost:${batchWebPort}`;

  // Worktree freshness gate — auto-sync or block stale demos (before prerequisites so
  // prerequisites run against up-to-date code)
  const batchFreshness = checkAndSyncWorktree();
  if (!batchFreshness.fresh) {
    return JSON.stringify({ error: `Worktree stale: ${batchFreshness.message}` });
  }

  // Execute prerequisites — starts dev server if registered as background prereq
  const prereqResult = await executePrerequisites({ base_url: devServerUrl });
  if (!prereqResult.success) {
    return JSON.stringify({ error: `Prerequisites failed: ${prereqResult.message}. Run preflight_check to diagnose. Do NOT bypass by running Playwright directly.` });
  }

  // Verify dev server is healthy (fallback if no prerequisite started it)
  const devServer = await ensureDevServer(devServerUrl);
  if (!devServer.ready) {
    return JSON.stringify({ error: `Dev server not ready after prerequisites: ${devServer.message}. Register a dev server prerequisite with register_prerequisite (scope: "global", run_as_background: true, with a health_check).` });
  }
  const effectiveBatchBaseUrl = args.base_url || devServerUrl;

  // Discover scenarios
  const scenarios = discoverScenarios({
    scenario_ids: args.scenario_ids,
    persona_ids: args.persona_ids,
    category_filter: args.category_filter,
  });

  if (scenarios.length === 0) {
    return JSON.stringify({ error: 'No matching scenarios found. Check filters or ensure demo_scenarios table has enabled entries.' });
  }

  const batchId = crypto.randomBytes(8).toString('hex');
  // Default batch_size to maxConcurrentMachines — runs all scenarios with max parallelism.
  // Multiple concurrent batches share the machine pool via Fly.io's own capacity limits.
  const flySection = getFlyConfigFromServices();
  const maxMachines = flySection?.maxConcurrentMachines || 10;
  const batchSize = args.batch_size ?? maxMachines;
  const totalBatches = Math.ceil(scenarios.length / batchSize);

  // Build scenario env_vars map for batch execution
  const scenarioEnvMap = new Map<string, Record<string, string>>();
  for (const s of scenarios) {
    if (s.env_vars && Object.keys(s.env_vars).length > 0) {
      scenarioEnvMap.set(s.id, s.env_vars);
    }
  }

  const batchScenarios: BatchScenarioResult[] = scenarios.map(s => ({
    scenario_id: s.id,
    scenario_title: s.title,
    test_file: s.test_file,
    status: 'pending' as const,
  }));

  const state: DemoBatchState = {
    batch_id: batchId,
    project: args.project,
    status: 'running',
    started_at: new Date().toISOString(),
    scenarios: batchScenarios,
    progress: {
      total_scenarios: scenarios.length,
      completed: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      current_batch: 0,
      total_batches: totalBatches,
    },
    stop_on_failure: args.stop_on_failure ?? false,
  };

  demoBatches.set(batchId, state);
  persistDemoBatches();

  // Determine remote-eligible scenarios
  const remoteScenarioIds = new Set<string>();
  const batchFlyConfig = getFlyConfigFromServices();
  if (batchFlyConfig && batchFlyConfig.enabled !== false && batchFlyConfig.appName && args.remote !== false) {
    try {
      const executionTargetMod = await import('./execution-target.js');
      for (const scenario of state.scenarios) {
        // Look up test_file for chrome-bridge detection
        let scenarioTestFile = '';
        try {
          const feedbackDbPath = getUserFeedbackDbPath();
          if (fs.existsSync(feedbackDbPath)) {
            const db = new Database(feedbackDbPath, { readonly: true });
            try {
              const row = db.prepare('SELECT test_file, headed, remote_eligible FROM demo_scenarios WHERE id = ?')
                .get(scenario.scenario_id) as { test_file: string | null; headed: number | null; remote_eligible: number | null } | undefined;
              if (row?.test_file) scenarioTestFile = row.test_file;
              // NOTE: headed flag is ignored — all demos run headed with video recording.
              // Headed scenarios run remotely via Xvfb + ffmpeg just like all others.
              if (row?.remote_eligible === 0) {
                // When remote requested, skip remote-ineligible scenarios (don't run locally)
                if (args.remote === true) {
                  scenario.status = 'skipped';
                  scenario.failure_summary = 'Skipped — scenario marked remote_eligible=false, cannot run on Fly.io';
                  state.progress.skipped++;
                  state.progress.completed++;
                }
                db.close(); continue;
              }
            } catch { /* */ }
            db.close();
          }
        } catch { /* non-fatal */ }

        const usesChromeBridge = executionTargetMod.detectChromeBridgeUsage(scenarioTestFile);
        if (usesChromeBridge) {
          // Chrome-bridge scenarios can't run remotely
          if (args.remote === true) {
            scenario.status = 'skipped';
            scenario.failure_summary = 'Skipped — chrome-bridge scenario requires local Chrome extension';
            state.progress.skipped++;
            state.progress.completed++;
          }
          continue;
        }
        if (!args.headless) {
          // Headed batch can't run remotely unless explicitly remote
          continue;
        }
        remoteScenarioIds.add(scenario.scenario_id);
      }
    } catch { /* non-fatal — all local */ }
  }

  // Persist skipped scenarios before launching
  persistDemoBatches();

  // Launch execution — local and remote paths concurrently
  const executionPromises: Promise<void>[] = [];

  if (remoteScenarioIds.size > 0) {
    executionPromises.push(
      runRemoteBatchSequence(state, args, remoteScenarioIds)
    );
  }

  // Always run the local batch sequence — it will skip non-pending (remote) scenarios
  executionPromises.push(
    runBatchSequence(state, args, scenarioEnvMap, devServer.ready, effectiveBatchBaseUrl)
  );

  Promise.all(executionPromises).catch((err) => {
    state.status = 'failed';
    state.ended_at = new Date().toISOString();
    process.stderr.write(`[playwright] Batch ${batchId} crashed: ${err instanceof Error ? err.message : err}\n`);
    persistDemoBatches();
  });

  return JSON.stringify({
    batch_id: batchId,
    total_scenarios: scenarios.length,
    total_batches: totalBatches,
    scenarios: batchScenarios.map(s => ({ id: s.scenario_id, title: s.scenario_title, test_file: s.test_file })),
    message: `Batch run started: ${scenarios.length} scenarios in ${totalBatches} batch(es) of ${batchSize}. Use check_demo_batch_result to monitor progress.`,
  });
}

/**
 * Check the progress/result of a batch demo run.
 */
function checkDemoBatchResult(args: CheckDemoBatchResultArgs): CheckDemoBatchResultResult {
  const { batch_id } = args;
  let state = demoBatches.get(batch_id);

  if (!state) {
    loadPersistedDemoBatches();
    state = demoBatches.get(batch_id);
  }

  if (!state) {
    return {
      status: 'failed',
      batch_id,
      progress: { total_scenarios: 0, completed: 0, passed: 0, failed: 0, skipped: 0, current_batch: 0, total_batches: 0 },
      scenarios: [],
      message: `No batch run found for ID ${batch_id}.`,
    };
  }

  // If running, update progress from current progress file
  if (state.status === 'running' && state.current_progress_file) {
    const progress = readDemoProgress(state.current_progress_file);
    if (progress) {
      state.progress.current_scenario = progress.current_test ?? state.progress.current_scenario;
    }
  }

  const durationSec = state.ended_at
    ? Math.round((new Date(state.ended_at).getTime() - new Date(state.started_at).getTime()) / 1000)
    : Math.round((Date.now() - new Date(state.started_at).getTime()) / 1000);

  let message: string;
  switch (state.status) {
    case 'running':
      message = `Batch running: ${state.progress.completed}/${state.progress.total_scenarios} completed ` +
        `(${state.progress.passed} passed, ${state.progress.failed} failed) — ` +
        `batch ${state.progress.current_batch}/${state.progress.total_batches}` +
        (state.progress.current_scenario ? ` — current: ${state.progress.current_scenario}` : '') +
        ` (${durationSec}s elapsed)`;
      break;
    case 'passed':
      message = `Batch completed: all ${state.progress.total_scenarios} scenarios passed in ${durationSec}s.`;
      break;
    case 'failed':
      message = `Batch completed with failures: ${state.progress.passed} passed, ${state.progress.failed} failed` +
        (state.progress.skipped > 0 ? `, ${state.progress.skipped} skipped` : '') +
        ` in ${durationSec}s.`;
      break;
    case 'stopped':
      message = `Batch stopped: ${state.progress.completed}/${state.progress.total_scenarios} completed before stop.`;
      break;
  }

  const batchResult: CheckDemoBatchResultResult = {
    status: state.status,
    batch_id,
    progress: { ...state.progress },
    scenarios: state.scenarios.map(s => ({ ...s })),
    message,
  };

  if (state.retried_scenarios && state.retried_scenarios.length > 0) {
    batchResult.retried_scenarios = state.retried_scenarios.map(r => ({ ...r }));
  }

  // Add machine slot pool status when Fly.io is configured
  try {
    const poolStatus = machinePool.getPoolStatus();
    if (poolStatus.activeSlots > 0 || Object.keys(poolStatus.byBatch).length > 0) {
      batchResult.pool_status = poolStatus;
    }
  } catch { /* non-fatal — pool status is informational */ }

  return batchResult;
}

/**
 * Stop a running batch demo run.
 */
function stopDemoBatch(args: StopDemoBatchArgs): StopDemoBatchResult {
  const { batch_id } = args;
  const state = demoBatches.get(batch_id);

  if (!state) {
    return {
      success: false,
      batch_id,
      progress: { total_scenarios: 0, completed: 0, passed: 0, failed: 0, skipped: 0, current_batch: 0, total_batches: 0 },
      scenarios: [],
      message: `No batch run found for ID ${batch_id}.`,
    };
  }

  if (state.status !== 'running') {
    return {
      success: true,
      batch_id,
      progress: { ...state.progress },
      scenarios: state.scenarios.map(s => ({ ...s })),
      message: `Batch already ${state.status}.`,
    };
  }

  // Kill current process
  if (state.current_pid) {
    try { process.kill(-state.current_pid, 'SIGTERM'); } catch { /* already dead */ }
  }

  state.status = 'stopped';
  state.ended_at = new Date().toISOString();
  for (const s of state.scenarios) {
    if (s.status === 'pending' || s.status === 'running') {
      s.status = 'skipped';
    }
  }
  state.progress.skipped = state.scenarios.filter(s => s.status === 'skipped').length;

  persistDemoBatches();

  return {
    success: true,
    batch_id,
    progress: { ...state.progress },
    scenarios: state.scenarios.map(s => ({ ...s })),
    message: `Batch stopped. ${state.progress.completed}/${state.progress.total_scenarios} completed.`,
  };
}

// ============================================================================
// Demo Screenshot Retrieval
// ============================================================================

/**
 * Retrieve the closest screenshot to a requested timestamp from a demo run.
 */
function getDemoScreenshot(args: GetDemoScreenshotArgs): GetDemoScreenshotResult | { error: string } {
  const screenshotDir = path.join(
    PROJECT_DIR,
    '.claude',
    'recordings',
    'demos',
    args.scenario_id,
    'screenshots',
  );

  if (!fs.existsSync(screenshotDir)) {
    return {
      error: `No screenshots found for scenario "${args.scenario_id}". Screenshots are captured during headed demo runs on macOS.`,
    };
  }

  let files: string[];
  try {
    files = fs.readdirSync(screenshotDir).filter(f => f.endsWith('.png')).sort();
  } catch {
    return { error: `Failed to read screenshot directory for scenario "${args.scenario_id}".` };
  }

  if (files.length === 0) {
    return {
      error: `Screenshot directory exists but contains no images for scenario "${args.scenario_id}".`,
    };
  }

  // Parse timestamps from filenames: screenshot-0003.png -> 3
  const timestamps = files
    .map(f => {
      const match = f.match(/screenshot-(\d+)\.png$/);
      return match ? { file: f, seconds: parseInt(match[1], 10) } : null;
    })
    .filter((t): t is { file: string; seconds: number } => t !== null);

  if (timestamps.length === 0) {
    return { error: 'Could not parse screenshot timestamps from filenames.' };
  }

  // Find closest screenshot to requested timestamp
  let closest = timestamps[0];
  let minDiff = Math.abs(args.timestamp_seconds - closest.seconds);
  for (const t of timestamps) {
    const diff = Math.abs(args.timestamp_seconds - t.seconds);
    if (diff < minDiff) {
      minDiff = diff;
      closest = t;
    }
  }

  return {
    file_path: path.join(screenshotDir, closest.file),
    actual_timestamp_seconds: closest.seconds,
    total_screenshots: timestamps.length,
    message:
      `Screenshot at ${closest.seconds}s (requested ${args.timestamp_seconds}s, delta ${minDiff}s). ` +
      `Use the Read tool to view this image. ` +
      `${timestamps.length} total screenshots available (0s to ${timestamps[timestamps.length - 1].seconds}s).`,
  };
}

/**
 * Extract high-resolution video frames around a given timestamp.
 * Uses ffmpeg to extract frames at 0.5s intervals, 3s before and after the timestamp.
 */
function extractVideoFrames(args: ExtractVideoFramesArgs): ExtractVideoFramesResult | { error: string } {
  const videoPath = path.join(PROJECT_DIR, '.claude', 'recordings', 'demos', `${args.scenario_id}.mp4`);

  const result = extractFramesFromVideo(videoPath, args.timestamp_seconds);
  if ('error' in result) return result;

  return {
    frames: result.frames,
    video_path: videoPath,
    range: result.range,
    total_frames: result.frames.length,
    message:
      `Extracted ${result.frames.length} frames from ${result.range.start_seconds}s to ${result.range.end_seconds}s (0.5s intervals). ` +
      `Use the Read tool to view any frame image. ` +
      'IMPORTANT: Analyze these frames to verify the UI state matches user requirements and expected behavior.',
  };
}

// ============================================================================
// Display Queue Tools
// ============================================================================

/**
 * Load the display-lock module dynamically.
 * Returns null if the module cannot be loaded (non-fatal — display-lock.js
 * is a hook-lib file and may not exist in all environments).
 */
async function loadDisplayLock(): Promise<{
  acquireDisplayLock: (agentId: string, queueId: string | null, title: string, opts?: { ttlMinutes?: number }) => { acquired: boolean; position?: number; holder?: Record<string, unknown>; queue_entry_id?: string };
  releaseDisplayLock: (agentId: string) => { released: boolean; next_holder?: Record<string, unknown> | null };
  renewDisplayLock: (agentId: string, ttlMinutes?: number) => { renewed: boolean; expires_at?: string };
  getDisplayLockStatus: () => { locked: boolean; holder: Record<string, unknown> | null; expires_at: string | null; queue: Array<Record<string, unknown>> };
} | null> {
  try {
    if (!fs.existsSync(DISPLAY_LOCK_PATH)) return null;
    const mod = await import(DISPLAY_LOCK_PATH) as {
      acquireDisplayLock: (agentId: string, queueId: string | null, title: string, opts?: { ttlMinutes?: number }) => { acquired: boolean; position?: number; holder?: Record<string, unknown>; queue_entry_id?: string };
      releaseDisplayLock: (agentId: string) => { released: boolean; next_holder?: Record<string, unknown> | null };
      renewDisplayLock: (agentId: string, ttlMinutes?: number) => { renewed: boolean; expires_at?: string };
      getDisplayLockStatus: () => { locked: boolean; holder: Record<string, unknown> | null; expires_at: string | null; queue: Array<Record<string, unknown>> };
    };
    return mod;
  } catch {
    return null;
  }
}

/** Get caller agent ID from env — falls back to 'unknown'. */
function getCallerAgentId(): string {
  return process.env.CLAUDE_AGENT_ID || 'unknown';
}

/** Get caller queue ID from env — prefers CLAUDE_QUEUE_ID (session-queue item ID) for PID lookup. */
function getCallerQueueId(): string | null {
  return process.env.CLAUDE_QUEUE_ID || process.env.CLAUDE_SESSION_ID || null;
}

/**
 * Fire-and-forget display lock release for a PID that was auto-acquired by run_demo.
 * Only releases if the PID is in displayLockAutoAcquiredPids.
 * Non-fatal — errors are swallowed.
 */
function autoReleaseDisplayLockForPid(pid: number): void {
  if (!displayLockAutoAcquiredPids.has(pid)) return;
  displayLockAutoAcquiredPids.delete(pid);
  const agentId = getCallerAgentId();
  loadDisplayLock().then((mod) => {
    if (mod) mod.releaseDisplayLock(agentId);
  }).catch(() => { /* Non-fatal */ });
}

async function acquireDisplayLockTool(args: AcquireDisplayLockArgs): Promise<string> {
  const displayLock = await loadDisplayLock();
  if (!displayLock) {
    return JSON.stringify({ error: 'Display lock module not available — display-lock.js not found in hooks/lib' });
  }

  const agentId = getCallerAgentId();
  const queueId = getCallerQueueId();
  const result = displayLock.acquireDisplayLock(agentId, queueId, args.title, { ttlMinutes: args.ttl_minutes });

  if (result.acquired) {
    return JSON.stringify({
      acquired: true,
      agent_id: agentId,
      title: args.title,
      ttl_minutes: args.ttl_minutes,
      message: `Display lock acquired. You have exclusive headed-mode access for up to ${args.ttl_minutes} minutes. Call release_display_lock when done.`,
    });
  } else {
    const holder = result.holder as Record<string, unknown> | undefined;
    return JSON.stringify({
      acquired: false,
      position: result.position,
      holder: holder ? {
        agent_id: holder['agent_id'],
        title: holder['title'],
        acquired_at: holder['acquired_at'],
        expires_at: holder['expires_at'],
      } : null,
      queue_entry_id: result.queue_entry_id,
      message: `Display lock held by agent "${holder?.['agent_id'] ?? 'unknown'}". You are at position ${result.position} in the queue. Call get_display_queue_status to check when it is your turn, then try acquire_display_lock again.`,
    });
  }
}

async function releaseDisplayLockTool(_args: Record<string, never>): Promise<string> {
  const displayLock = await loadDisplayLock();
  if (!displayLock) {
    return JSON.stringify({ error: 'Display lock module not available — display-lock.js not found in hooks/lib' });
  }

  const agentId = getCallerAgentId();
  const result = displayLock.releaseDisplayLock(agentId);

  if (!result.released) {
    return JSON.stringify({
      released: false,
      message: `Display lock was not held by this agent (${agentId}). Either it was already released or never acquired.`,
    });
  }

  const next = result.next_holder as Record<string, unknown> | null | undefined;
  return JSON.stringify({
    released: true,
    next_holder: next ? {
      agent_id: next['agent_id'],
      queue_id: next['queue_id'],
      title: next['title'],
    } : null,
    message: next
      ? `Display lock released. Next agent in queue ("${next['agent_id'] ?? 'unknown'}") has been promoted.`
      : 'Display lock released. Queue is now empty.',
  });
}

async function renewDisplayLockTool(_args: Record<string, never>): Promise<string> {
  const displayLock = await loadDisplayLock();
  if (!displayLock) {
    return JSON.stringify({ error: 'Display lock module not available — display-lock.js not found in hooks/lib' });
  }

  const agentId = getCallerAgentId();
  const result = displayLock.renewDisplayLock(agentId);

  if (!result.renewed) {
    return JSON.stringify({
      renewed: false,
      message: `Display lock renewal failed — this agent (${agentId}) does not hold the lock. Acquire it first with acquire_display_lock.`,
    });
  }

  return JSON.stringify({
    renewed: true,
    expires_at: result.expires_at,
    message: `Display lock TTL extended. New expiry: ${result.expires_at}. Call renew_display_lock again before expiry to maintain access.`,
  });
}

async function getDisplayQueueStatusTool(_args: Record<string, never>): Promise<string> {
  const displayLock = await loadDisplayLock();
  if (!displayLock) {
    return JSON.stringify({
      available: false,
      message: 'Display lock module not available — display-lock.js not found in hooks/lib. Display queue is not active.',
    });
  }

  const status = displayLock.getDisplayLockStatus();
  const callerAgentId = getCallerAgentId();

  const isHolder = !!(status.holder && (status.holder as Record<string, unknown>)['agent_id'] === callerAgentId);
  const callerInQueue = status.queue.find((e) => (e as Record<string, unknown>)['agent_id'] === callerAgentId);

  return JSON.stringify({
    locked: status.locked,
    holder: status.holder,
    expires_at: status.expires_at,
    queue_length: status.queue.length,
    queue: status.queue,
    caller_is_holder: isHolder,
    caller_queue_position: callerInQueue ? (callerInQueue as Record<string, unknown>)['position'] : null,
    message: !status.locked
      ? 'Display is free. Call acquire_display_lock to get exclusive access before running headed demos.'
      : isHolder
        ? `You hold the display lock (expires ${status.expires_at}). ${status.queue.length} agent(s) waiting.`
        : `Display lock held by agent "${(status.holder as Record<string, unknown>)?.['agent_id'] ?? 'unknown'}". Queue length: ${status.queue.length}.`,
  });
}

// ============================================================================
// Server Setup
// ============================================================================

const tools: AnyToolHandler[] = [
  {
    name: 'launch_ui_mode',
    description:
      'Launch Playwright in interactive UI mode for manual testing and demos. ' +
      'Opens a browser with the Playwright test runner UI. ' +
      'Project names are discovered from the target project\'s playwright.config.ts.',
    schema: LaunchUiModeArgsSchema,
    handler: launchUiMode,
  },
  {
    name: 'run_demo',
    description:
      'Run a demo scenario. Two main flags: "recorded" (default true — captures video) and "remote" (default true — runs on Fly.io). ' +
      'ALWAYS prefer remote+recorded (the defaults) unless the CTO explicitly requests local execution. ' +
      'Remote execution avoids display lock contention, runs in parallel, and produces identical recordings via Xvfb+ffmpeg. ' +
      'RECORDING: When recorded=true (default), runs headed with video recording. Locally uses ScreenCaptureKit; ' +
      'remotely uses Xvfb + ffmpeg. Screenshots extracted at 3s intervals in both cases. ' +
      'When recorded=false, runs headless without video. ' +
      'REMOTE: When remote=true (default), runs on Fly.io with auto-push of worktree branches. ' +
      'When remote=false, runs locally — only use this when the CTO asks to watch live, or when chrome-bridge/extension interaction is required. ' +
      'Spawned agents must use remote execution (Fly.io). Local demos are reserved for the CTO dashboard and interactive sessions. ' +
      'Scenario videos: `.claude/recordings/demos/{scenarioId}.mp4`. ' +
      'Prerequisites execute automatically if registered via register_prerequisite. ' +
      'If this tool fails on prerequisites, run preflight_check to diagnose.',
    schema: RunDemoArgsSchema,
    handler: runDemo,
  },
  {
    name: 'check_demo_result',
    description:
      'Check the result of a previously launched demo run by PID. ' +
      'Call after run_demo to determine if the demo passed or failed. ' +
      'Returns status (running/passed/failed/unknown), exit code, failure summary, screenshot paths, ' +
      'recording_path, recording_source (window/none), ' +
      'recording_permission_error (set when Screen Recording permission is denied — contains the full error message and fix instructions), ' +
      'and a progress object with real-time test counts, current test name, and error detection. ' +
      'Demos are NOT auto-killed if you stop polling — they run to completion or timeout. ' +
      'Poll periodically to monitor progress, but the demo will finish regardless. ' +
      'Includes degraded_features array when tests report warning annotations on soft-guarded features. ' +
      'When the demo completes, screenshot_hint and analysis_guidance fields tell you exactly which screenshots and video frames to review. Always follow the analysis_guidance instructions.',
    schema: CheckDemoResultArgsSchema,
    handler: checkDemoResult,
  },
  {
    name: 'stop_demo',
    description:
      'Stop a running demo by PID. Kills the Playwright process group and returns ' +
      'the final progress snapshot. Use when failures are detected mid-run and you ' +
      'want to abort the remaining tests.',
    schema: StopDemoArgsSchema,
    handler: stopDemo,
  },
  {
    name: 'get_demo_screenshot',
    description:
      'Retrieve a screenshot from a completed (or running) demo run. Screenshots are captured every 3 seconds ' +
      'during headed demos on macOS. Provide scenario_id and timestamp_seconds — returns the closest screenshot ' +
      'file path. Use the Read tool to view the image. ' +
      'After viewing, analyze the screenshot to verify the UI state matches the expected user experience and requirements.',
    schema: GetDemoScreenshotArgsSchema,
    handler: getDemoScreenshot,
  },
  {
    name: 'extract_video_frames',
    description:
      'Extract high-resolution frames from a demo scenario\'s video recording. ' +
      'Extracts frames at 0.5s intervals, 3 seconds before and after the given timestamp (13 frames total). ' +
      'Requires ffmpeg. Use the Read tool to view extracted frame images. ' +
      'Use this to inspect specific moments in detail — e.g., verify UI state at a critical step or diagnose a failure.',
    schema: ExtractVideoFramesArgsSchema,
    handler: extractVideoFrames,
  },
  {
    name: 'run_prerequisites',
    description:
      'Execute registered demo prerequisites. Runs health checks first — if a prerequisite\'s ' +
      'health check passes (exit 0), its setup command is skipped (idempotent). ' +
      'Background prerequisites (dev servers) are spawned detached and polled via health check. ' +
      'Returns per-prerequisite pass/fail/skip status. ' +
      'Automatically called by run_demo, run_demo_batch, and preflight_check. ' +
      'Use this tool for explicit manual prerequisite execution.',
    schema: RunPrerequisitesArgsSchema,
    handler: async (args: RunPrerequisitesArgs) => executePrerequisites(args),
  },
  {
    name: 'run_tests',
    description:
      'Run Playwright E2E tests headlessly and return pass/fail results. ' +
      'Filter by project (persona) or test name pattern. ' +
      'Runs seed + auth-setup automatically as dependencies.',
    schema: RunTestsArgsSchema,
    handler: runTests,
  },
  {
    name: 'seed_data',
    description:
      'Seed the E2E test database with deterministic test data. ' +
      'Creates vendor accounts, customers, integrations, webhooks, API keys, and audit entries. ' +
      'Idempotent — safe to run multiple times.',
    schema: SeedDataArgsSchema,
    handler: seedData,
  },
  {
    name: 'cleanup_data',
    description:
      'Clean up E2E test data from the database. ' +
      'Removes all e2e-* prefixed test records. ' +
      'Set E2E_CLEANUP=true internally.',
    schema: CleanupDataArgsSchema,
    handler: cleanupData,
  },
  {
    name: 'get_report',
    description:
      'Get the last Playwright HTML test report. ' +
      'Shows report path, last modified time, and optionally opens in browser.',
    schema: GetReportArgsSchema,
    handler: getReport,
  },
  {
    name: 'get_coverage_status',
    description:
      'Check E2E test coverage by persona and page. ' +
      'Returns a matrix of all Playwright projects with test counts, ' +
      'persona labels, and active/deferred status.',
    schema: GetCoverageStatusArgsSchema,
    handler: getCoverageStatus,
  },
  {
    name: 'preflight_check',
    description:
      'Run comprehensive pre-flight validation before launching Playwright. ' +
      'Checks config file, dependencies, browsers, test files, credentials, ' +
      'compilation, dev server, and auth state freshness. ALWAYS run before launch_ui_mode or run_tests. ' +
      'Also detects stale dev server builds by comparing source file timestamps against .next/ build artifacts (Next.js). ' +
      'Runs registered prerequisites first (step 0) — including dev server start if registered via register_prerequisite. ' +
      'To register a dev server: register_prerequisite({ command: "pnpm dev", scope: "global", run_as_background: true, health_check: "curl -sf http://localhost:3000" }). ' +
      'Returns structured result with pass/fail per check and recovery steps.',
    schema: PreflightCheckArgsSchema,
    handler: preflightCheck,
  },
  {
    name: 'run_auth_setup',
    description:
      'Refresh Playwright auth state by running seed + auth-setup projects. ' +
      'Run when .auth/*.json files are missing, expired, or stale (>4h old). ' +
      'Automatically starts the dev server via playwright.config.ts webServer config. ' +
      'Takes 2–4 minutes. Required before demo tests can authenticate.',
    schema: RunAuthSetupArgsSchema,
    handler: runAuthSetup,
  },
  {
    name: 'list_extension_tabs',
    description:
      'List all open tabs in the CDP-connected extension test browser. ' +
      'Requires the extension test browser to be running with --remote-debugging-port=9222. ' +
      'Launch it first with launch_ui_mode({ project: "demo" }) and click a test. ' +
      'Returns tab IDs, titles, and URLs — use with screenshot_extension_tab.',
    schema: ListExtensionTabsArgsSchema,
    handler: listExtensionTabs,
  },
  {
    name: 'screenshot_extension_tab',
    description:
      'Take a screenshot of a specific tab in the extension test browser via CDP. ' +
      'Returns a base64 PNG image that renders inline in Claude Code. ' +
      'Use url_pattern to match by URL substring (e.g. "popup.html", "dashboard"). ' +
      'Requires the extension test browser to be running (see launch_ui_mode with project "demo").',
    schema: ScreenshotExtensionTabArgsSchema,
    handler: screenshotExtensionTab,
  },
  {
    name: 'open_video',
    description:
      'Open a video file in the system\'s default media player. ' +
      'Accepts absolute or relative paths (resolved from the project directory). ' +
      'Use with video paths from check_demo_result artifacts or .claude/recordings/.',
    schema: OpenVideoArgsSchema,
    handler: openVideo,
  },
  {
    name: 'run_demo_batch',
    description:
      'Run demo scenarios concurrently on Fly.io. ' +
      'Defaults to maxConcurrentMachines parallelism (typically 10). Multiple concurrent batch runs share the Fly machine pool. ' +
      'Defaults: headless=true, remote=true, retry_infra_failures=1. ' +
      'Spawned agents must use remote execution (Fly.io). Local batch demos are reserved for the CTO dashboard and interactive sessions. ' +
      'remote_eligible=false scenarios are automatically excluded from remote batches and from the production promotion pipeline (verify_demo_completeness). ' +
      'Do NOT run remote-ineligible scenarios unless explicitly directed by the CTO — they require local Chrome/display access. ' +
      'Discovers scenarios from user-feedback.db — filter by scenario_ids, persona_ids, or category. ' +
      'Returns a batch_id for polling via check_demo_batch_result. ' +
      'Dev server is auto-started if not running.',
    schema: RunDemoBatchArgsSchema,
    handler: runDemoBatch,
  },
  {
    name: 'check_demo_batch_result',
    description:
      'Check progress or final result of a batch demo run. ' +
      'Returns per-scenario status, failure summaries, and aggregate progress. ' +
      'Batches are NOT auto-killed if you stop polling — they run to completion or batch_timeout. Poll periodically to monitor progress.',
    schema: CheckDemoBatchResultArgsSchema,
    handler: checkDemoBatchResult,
  },
  {
    name: 'stop_demo_batch',
    description:
      'Stop a running batch demo run. Kills the current Playwright process and marks remaining scenarios as skipped. ' +
      'Returns the final progress snapshot.',
    schema: StopDemoBatchArgsSchema,
    handler: stopDemoBatch,
  },
  {
    name: 'acquire_display_lock',
    description:
      'Acquire exclusive display access for headed demos or real Chrome (chrome-bridge) usage. ' +
      'If another agent holds the lock, you are placed in a queue and must wait — check position with get_display_queue_status, then retry. ' +
      'Call this BEFORE run_demo with headless=false or any chrome-bridge tool usage that requires exclusive display access. ' +
      'run_demo auto-acquires the lock when headless=false, but explicit acquisition is recommended for sequential headed demos. ' +
      'Headed demos are serialized through this queue to prevent window capture conflicts and corrupted recordings.',
    schema: AcquireDisplayLockArgsSchema,
    handler: acquireDisplayLockTool,
  },
  {
    name: 'release_display_lock',
    description:
      'Release exclusive display access after headed demos or Chrome usage completes. ' +
      'ALWAYS call this when done with headed mode, even if the demo failed. ' +
      'Failure to release blocks other agents waiting in queue. ' +
      'run_demo auto-releases the lock when the demo completes (via check_demo_result or stop_demo), ' +
      'but you must release manually if you acquired the lock explicitly.',
    schema: ReleaseDisplayLockArgsSchema,
    handler: releaseDisplayLockTool,
  },
  {
    name: 'renew_display_lock',
    description:
      'Extend your display lock TTL (heartbeat). ' +
      'Call every 5 minutes during long headed demo sessions to prevent auto-expiry. ' +
      'The lock auto-expires after its TTL (default 15 minutes) if not renewed or released.',
    schema: RenewDisplayLockArgsSchema,
    handler: renewDisplayLockTool,
  },
  {
    name: 'get_display_queue_status',
    description:
      'Check the current display lock holder and waiting queue. ' +
      'Use before deciding whether to run headed or headless, or to check your queue position after a failed acquire attempt. ' +
      'Returns locked state, current holder details, queue entries, and whether you are the current holder.',
    schema: GetDisplayQueueStatusArgsSchema,
    handler: getDisplayQueueStatusTool,
  },
  {
    name: 'get_fly_status',
    description: 'Get Fly.io remote execution status. Shows whether Fly.io is configured, running machines, and recent remote demo runs.',
    schema: GetFlyStatusArgsSchema,
    handler: async (_args: GetFlyStatusArgs) => {
      try {
        // Read fly config from services.json
        const flySection = getFlyConfigFromServices();
        if (!flySection) {
          return JSON.stringify({
            configured: false,
            message: 'Fly.io not configured. Add a "fly" section to services.json via /setup-fly or update_services_config.',
          });
        }

        if (!flySection.enabled) {
          return JSON.stringify({
            configured: true,
            enabled: false,
            appName: flySection.appName,
            message: 'Fly.io is configured but disabled. Set fly.enabled=true in services.json to activate.',
          });
        }

        // Resolve API token
        let apiToken: string;
        try {
          const { resolved, failedKeys, failureDetails } = resolveOpReferencesStrict({ FLY_API_TOKEN: flySection.apiToken });
          if (failedKeys.length > 0) {
            return JSON.stringify({
              configured: true,
              enabled: true,
              healthy: false,
              message: `FLY_API_TOKEN credential resolution failed: ${failureDetails['FLY_API_TOKEN'] || 'unknown error'}`,
            });
          }
          apiToken = resolved['FLY_API_TOKEN'];
        } catch {
          return JSON.stringify({
            configured: true,
            enabled: true,
            healthy: false,
            message: 'Failed to resolve FLY_API_TOKEN from 1Password',
          });
        }

        // Dynamically import fly-runner to avoid hard dependency in environments where it is absent
        let flyRunner: {
          listActiveMachines: (config: {
            apiToken: string;
            appName: string;
            region: string;
            machineSize: string;
            machineRam: number;
            maxConcurrentMachines: number;
          }) => Promise<Array<{ id: string; state: string; created_at: string }>>;
        };
        try {
          flyRunner = await import('./fly-runner.js');
        } catch {
          return JSON.stringify({
            configured: true,
            enabled: true,
            healthy: false,
            message: 'fly-runner module not available. Remote Fly.io execution is not built into this installation.',
          });
        }

        const flyConfig = {
          apiToken,
          appName: flySection.appName,
          region: flySection.region || 'iad',
          machineSize: flySection.machineSize || 'shared-cpu-2x',
          machineRam: flySection.machineRam || 2048,
          maxConcurrentMachines: flySection.maxConcurrentMachines || 3,
        };

        // listActiveMachines serves as the health check: if the Fly API responds,
        // the configuration is healthy. On any error we surface it without throwing.
        let healthy = false;
        let activeMachines: Array<{ id: string; state: string; created_at: string }> = [];
        try {
          activeMachines = await flyRunner.listActiveMachines(flyConfig);
          healthy = true;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return JSON.stringify({
            configured: true,
            enabled: true,
            healthy: false,
            appName: flySection.appName,
            region: flyConfig.region,
            machineSize: flyConfig.machineSize,
            machineRam: flyConfig.machineRam,
            machineRamHeadless: readFlyMachineConfig().machineRamHeadless,
            machineRamHeaded: readFlyMachineConfig().machineRamHeaded,
            maxConcurrentMachines: flyConfig.maxConcurrentMachines,
            message: `Fly API unreachable: ${message}`,
          });
        }

        // Check image deployment via Fly registry API (best-effort, 5s timeout).
        // flyctl deploy creates deployment-* tags, never :latest, so we list tags
        // and check for any deployment-* tag — the same pattern used by resolveAppImage().
        let imageDeployed: boolean | null = null;
        let imageMessage = '';
        let projectImageDeployed: boolean | null = null;
        let registryTags: string[] = [];
        try {
          const controller = new AbortController();
          const registryTimer = setTimeout(() => controller.abort(), 5000);
          const registryResp = await fetch(
            `https://registry.fly.io/v2/${flyConfig.appName}/tags/list`,
            {
              method: 'GET',
              headers: { Authorization: `FlyV1 ${apiToken}` },
              signal: controller.signal,
            },
          );
          clearTimeout(registryTimer);
          if (registryResp.ok) {
            const data = (await registryResp.json()) as { tags?: string[] };
            registryTags = data.tags || [];
            imageDeployed = registryTags.some((t: string) => t.startsWith('deployment-'));
            projectImageDeployed = registryTags.some((t: string) => t.startsWith('project-'));
          } else {
            imageDeployed = false;
            projectImageDeployed = false;
          }
          if (!imageDeployed) {
            imageMessage = 'No Docker image is deployed to the Fly app. Remote execution will fail until the image is built and pushed. Fix: call deploy_fly_image() to build and push the image.';
          }
        } catch {
          // Registry check is best-effort — don't fail the whole status report
          imageDeployed = null;
          projectImageDeployed = null;
          imageMessage = 'Could not verify image deployment (registry API unreachable or timed out)';
        }

        // Check Tigris object storage configuration (best-effort, non-fatal)
        let tigrisConfigured = false;
        let tigrisBucket: string | undefined;
        try {
          const tigrisServicesPath = path.join(PROJECT_DIR, '.claude', 'config', 'services.json');
          const { isTigrisConfigured: checkTigris } = await import('./artifact-storage.js');
          tigrisConfigured = checkTigris(tigrisServicesPath);
          if (tigrisConfigured) {
            // Read bucket name from services.json without resolving credentials
            const raw = JSON.parse(fs.readFileSync(tigrisServicesPath, 'utf-8'));
            tigrisBucket = raw?.fly?.tigrisBucket;
          }
        } catch {
          // Non-fatal — Tigris is optional
        }

        // Check image staleness via infrastructure file hashes (best-effort, non-fatal)
        let imageMetadata: Record<string, unknown> | null = null;
        let imageStale = false;
        let imageAgeHours: number | null = null;
        let imageStaleReason = '';
        try {
          const metaPath = path.join(PROJECT_DIR, '.claude', 'state', 'fly-image-metadata.json');
          if (fs.existsSync(metaPath)) {
            imageMetadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
            // Compute current hashes of infra files
            const infraDirCandidates = [
              path.join(PROJECT_DIR, 'node_modules', 'gentyr', 'infra', 'fly-playwright'),
              path.join(PROJECT_DIR, 'infra', 'fly-playwright'),
            ];
            const infraDir = infraDirCandidates.find(d => fs.existsSync(d));
            if (infraDir && imageMetadata) {
              const currentDockerfileHash = crypto.createHash('sha256')
                .update(fs.readFileSync(path.join(infraDir, 'Dockerfile'))).digest('hex');
              const currentRunnerHash = crypto.createHash('sha256')
                .update(fs.readFileSync(path.join(infraDir, 'remote-runner.sh'))).digest('hex');
              const dockerChanged = currentDockerfileHash !== (imageMetadata as Record<string, string>).dockerfileHash;
              const runnerChanged = currentRunnerHash !== (imageMetadata as Record<string, string>).remoteRunnerHash;
              imageStale = dockerChanged || runnerChanged;
              if (imageStale) {
                const changed: string[] = [];
                if (dockerChanged) changed.push('Dockerfile');
                if (runnerChanged) changed.push('remote-runner.sh');
                imageStaleReason = `Changed since last deploy: ${changed.join(', ')}. Run deploy_fly_image({ force: true }) to rebuild.`;
              }
            }
            if (imageMetadata) {
              const deployedMs = new Date((imageMetadata as Record<string, string>).deployedAt).getTime();
              imageAgeHours = Math.round((Date.now() - deployedMs) / 3600000);
            }
          }
        } catch { /* non-fatal */ }

        // Check project image staleness via lockfile hash comparison (best-effort, non-fatal)
        let projectImageStale = false;
        let projectImageStaleReason = '';
        let projectImageMetadata: Record<string, unknown> | null = null;
        let projectImageDeploying = false;
        try {
          const projectMetaPath = path.join(PROJECT_DIR, '.claude', 'state', 'fly-project-image-metadata.json');
          if (fs.existsSync(projectMetaPath)) {
            projectImageMetadata = JSON.parse(fs.readFileSync(projectMetaPath, 'utf-8'));
            if (projectImageMetadata) {
              projectImageDeploying = (projectImageMetadata as Record<string, unknown>).deploying === true;
              const storedHash = (projectImageMetadata as Record<string, string>).lockfileHash;
              if (storedHash) {
                // Compute current lockfile hash
                const lockfilePath = path.join(EFFECTIVE_CWD, 'pnpm-lock.yaml');
                if (fs.existsSync(lockfilePath)) {
                  const currentHash = crypto.createHash('sha256')
                    .update(fs.readFileSync(lockfilePath))
                    .digest('hex');
                  if (currentHash !== storedHash) {
                    projectImageStale = true;
                    projectImageStaleReason = 'pnpm-lock.yaml has changed since the project image was built. Run deploy_project_image({ force: true }) to rebuild.';
                  }
                }
              }
            }
          }
        } catch { /* non-fatal */ }

        // Read fly config's projectImageEnabled setting
        const projectImageEnabled = flySection.projectImageEnabled === true;

        return JSON.stringify({
          configured: true,
          enabled: true,
          healthy: imageDeployed === false ? false : healthy,
          imageDeployed,
          imageStale,
          imageAgeHours,
          ...(imageMetadata ? { imageMetadata } : {}),
          ...(imageStaleReason ? { imageStaleReason } : {}),
          projectImageDeployed,
          projectImageEnabled,
          projectImageStale,
          projectImageDeploying,
          ...(projectImageMetadata ? { projectImageMetadata } : {}),
          ...(projectImageStaleReason ? { projectImageStaleReason } : {}),
          appName: flyConfig.appName,
          region: flyConfig.region,
          machineSize: flyConfig.machineSize,
          machineRam: flyConfig.machineRam,
          machineRamHeadless: readFlyMachineConfig().machineRamHeadless,
          machineRamHeaded: readFlyMachineConfig().machineRamHeaded,
          maxConcurrentMachines: flyConfig.maxConcurrentMachines,
          activeMachines: activeMachines.length,
          machines: activeMachines,
          tigrisConfigured,
          ...(tigrisBucket ? { tigrisBucket } : {}),
          ...(imageMessage ? { imageMessage } : {}),
        });
      } catch (err) {
        return JSON.stringify({
          configured: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  },
  {
    name: 'deploy_fly_image',
    description:
      'Build and deploy the Playwright Docker image to Fly.io. ' +
      'Call this when get_fly_status returns imageDeployed: false, or after GENTYR updates that change the Dockerfile. ' +
      'Runs the provisioning script in the background and returns immediately — poll get_fly_status() to check when imageDeployed becomes true.',
    schema: DeployFlyImageArgsSchema,
    handler: async (args: DeployFlyImageArgs) => {
      // 1. Read fly config
      const flySection = getFlyConfigFromServices();
      if (!flySection || !flySection.appName) {
        return JSON.stringify({
          success: false,
          message: 'Fly.io not configured. Run /setup-fly first.',
        });
      }

      // 2. Check if image already deployed (skip unless force)
      if (!args.force) {
        let apiToken: string | null = null;
        try {
          const { resolved, failedKeys } = resolveOpReferencesStrict({ FLY_API_TOKEN: flySection.apiToken });
          if (failedKeys.length === 0) apiToken = resolved['FLY_API_TOKEN'];
        } catch { /* continue — can't check, just deploy */ }

        if (apiToken) {
          try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 5000);
            const resp = await fetch(
              `https://registry.fly.io/v2/${flySection.appName}/tags/list`,
              {
                headers: { Authorization: `FlyV1 ${apiToken}` },
                signal: controller.signal,
              },
            );
            clearTimeout(timer);
            if (resp.ok) {
              const data = (await resp.json()) as { tags?: string[] };
              if (data.tags && data.tags.some((t: string) => t.startsWith('deployment-'))) {
                return JSON.stringify({
                  success: true,
                  alreadyDeployed: true,
                  message: `Image already deployed to ${flySection.appName}. Use force: true to redeploy.`,
                });
              }
            }
          } catch { /* can't check — just deploy */ }
        }
      }

      // 3. Find provision-app.sh
      // Resolve GENTYR_DIR: node_modules/gentyr (npm link) or . (gentyr repo itself)
      const candidates = [
        path.join(PROJECT_DIR, 'node_modules', 'gentyr', 'infra', 'fly-playwright', 'provision-app.sh'),
        path.join(PROJECT_DIR, 'infra', 'fly-playwright', 'provision-app.sh'),
      ];
      const scriptPath = candidates.find(p => fs.existsSync(p));
      if (!scriptPath) {
        return JSON.stringify({
          success: false,
          message: 'Could not find provision-app.sh. Ensure GENTYR is installed (node_modules/gentyr or working in gentyr repo).',
        });
      }

      // 4. Check flyctl is available
      try {
        execSync('which flyctl', { encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
      } catch {
        return JSON.stringify({
          success: false,
          message: 'flyctl is not installed. Install it with: brew install flyctl',
        });
      }

      // 5. Run provisioning script in background (takes 3-10 minutes for remote build)
      const logFile = path.join(PROJECT_DIR, '.claude', 'state', `fly-deploy-${Date.now()}.log`);
      fs.mkdirSync(path.dirname(logFile), { recursive: true });

      const logFd = fs.openSync(logFile, 'w');
      const child = spawn('bash', [
        scriptPath,
        '--app-name', flySection.appName,
        '--region', flySection.region || 'iad',
      ], {
        cwd: PROJECT_DIR,
        env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT_DIR },
        detached: true,
        stdio: ['ignore', logFd, logFd],
      });
      child.unref();
      fs.closeSync(logFd);

      return JSON.stringify({
        success: true,
        deploying: true,
        pid: child.pid,
        appName: flySection.appName,
        region: flySection.region || 'iad',
        logFile,
        message: `Deploying Docker image to ${flySection.appName} in background (PID ${child.pid}). This takes 3-10 minutes for the remote Docker build. Poll get_fly_status() to check when imageDeployed becomes true. Deploy log: ${logFile}`,
      });
    },
  },
  {
    name: 'deploy_project_image',
    description:
      'Build and deploy a project-specific Fly.io Docker image with pre-installed dependencies. ' +
      'Layers on top of the base image (from deploy_fly_image): clones the project repo, runs pnpm install, ' +
      'installs Playwright browsers, and optionally runs a build command. Reduces cold start from ~90s to ~10s. ' +
      'After deploying, set fly.projectImageEnabled=true in services.json via update_services_config to activate.',
    schema: DeployProjectImageArgsSchema,
    handler: async (args: DeployProjectImageArgs) => {
      // 1. Read fly config
      const flySection = getFlyConfigFromServices();
      if (!flySection || !flySection.appName) {
        return JSON.stringify({
          success: false,
          message: 'Fly.io not configured. Run /setup-fly first.',
        });
      }

      // 2. Resolve API token
      let apiToken: string;
      try {
        const { resolved, failedKeys } = resolveOpReferencesStrict({ FLY_API_TOKEN: flySection.apiToken });
        if (failedKeys.length > 0) {
          return JSON.stringify({
            success: false,
            message: 'FLY_API_TOKEN credential resolution failed. Check 1Password configuration.',
          });
        }
        apiToken = resolved['FLY_API_TOKEN'];
      } catch {
        return JSON.stringify({
          success: false,
          message: 'Failed to resolve FLY_API_TOKEN from 1Password.',
        });
      }

      // 3. Check if project image already exists (skip unless force)
      if (!args.force) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 5000);
          const resp = await fetch(
            `https://registry.fly.io/v2/${flySection.appName}/tags/list`,
            {
              headers: { Authorization: `FlyV1 ${apiToken}` },
              signal: controller.signal,
            },
          );
          clearTimeout(timer);
          if (resp.ok) {
            const data = (await resp.json()) as { tags?: string[] };
            if (data.tags && data.tags.some((t: string) => t.startsWith('project-'))) {
              return JSON.stringify({
                success: true,
                alreadyDeployed: true,
                message: `Project image already deployed to ${flySection.appName}. Use force: true to rebuild.`,
              });
            }
          }
        } catch { /* can't check — just deploy */ }
      }

      // 4. Resolve the base image tag (the project image FROMs this)
      let baseImageTag: string;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const resp = await fetch(
          `https://registry.fly.io/v2/${flySection.appName}/tags/list`,
          {
            headers: { Authorization: `FlyV1 ${apiToken}` },
            signal: controller.signal,
          },
        );
        clearTimeout(timer);
        if (resp.ok) {
          const data = (await resp.json()) as { tags?: string[] };
          const deployTags = (data.tags || [])
            .filter((t: string) => t.startsWith('deployment-'))
            .sort();
          if (deployTags.length > 0) {
            baseImageTag = `registry.fly.io/${flySection.appName}:${deployTags[deployTags.length - 1]}`;
          } else {
            return JSON.stringify({
              success: false,
              message: 'No base image found (no deployment-* tags). Run deploy_fly_image() first to build the base image.',
            });
          }
        } else {
          return JSON.stringify({
            success: false,
            message: 'Failed to query registry for base image tags. Ensure the Fly app exists and deploy_fly_image() has been run.',
          });
        }
      } catch (err: unknown) {
        return JSON.stringify({
          success: false,
          message: `Registry query failed: ${err instanceof Error ? err.message : String(err)}. Run deploy_fly_image() first.`,
        });
      }

      // 5. Resolve git remote and ref
      let gitRemote: string;
      let gitRef: string;
      try {
        gitRemote = execSync('git remote get-url origin', { cwd: EFFECTIVE_CWD, encoding: 'utf8', timeout: 5000, stdio: 'pipe' }).trim();
      } catch {
        return JSON.stringify({
          success: false,
          message: 'Could not determine git remote URL. Ensure the project is a git repo with an "origin" remote.',
        });
      }
      // Convert SSH URLs to HTTPS for Docker build context
      if (gitRemote.startsWith('git@')) {
        gitRemote = gitRemote.replace(/^git@([^:]+):/, 'https://$1/');
      }
      if (args.git_ref) {
        gitRef = args.git_ref;
      } else {
        try {
          gitRef = execSync('git rev-parse --abbrev-ref HEAD', { cwd: EFFECTIVE_CWD, encoding: 'utf8', timeout: 5000, stdio: 'pipe' }).trim();
        } catch {
          gitRef = 'main';
        }
      }

      // 6. Resolve GIT_AUTH_TOKEN from secrets if available
      let gitAuthToken = '';
      try {
        const services = loadServicesConfig(path.join(PROJECT_DIR, '.claude', 'config', 'services.json'));
        if (services?.secrets?.local) {
          const tokenRef = services.secrets.local['GITHUB_TOKEN'] || services.secrets.local['GIT_AUTH_TOKEN'];
          if (tokenRef && typeof tokenRef === 'string' && tokenRef.startsWith('op://')) {
            gitAuthToken = opRead(tokenRef);
          }
        }
      } catch { /* non-fatal — public repos work without token */ }

      // 7. Find Dockerfile.project
      const dockerfileCandidates = [
        path.join(PROJECT_DIR, 'node_modules', 'gentyr', 'infra', 'fly-playwright', 'Dockerfile.project'),
        path.join(PROJECT_DIR, 'infra', 'fly-playwright', 'Dockerfile.project'),
      ];
      const dockerfilePath = dockerfileCandidates.find(p => fs.existsSync(p));
      if (!dockerfilePath) {
        return JSON.stringify({
          success: false,
          message: 'Could not find Dockerfile.project. Ensure GENTYR is installed.',
        });
      }

      // 8. Compute current lockfile hash for staleness detection
      let lockfileHash = '';
      try {
        const lockfilePath = path.join(EFFECTIVE_CWD, 'pnpm-lock.yaml');
        if (fs.existsSync(lockfilePath)) {
          lockfileHash = crypto.createHash('sha256')
            .update(fs.readFileSync(lockfilePath))
            .digest('hex');
        }
      } catch { /* non-fatal */ }

      // 9. Compute git short SHA for image label
      let gitShortSha = 'unknown';
      try {
        gitShortSha = execSync('git rev-parse --short HEAD', { cwd: EFFECTIVE_CWD, encoding: 'utf8', timeout: 5000, stdio: 'pipe' }).trim();
      } catch { /* non-fatal */ }

      // 10. Check flyctl is available
      try {
        execSync('which flyctl', { encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
      } catch {
        return JSON.stringify({
          success: false,
          message: 'flyctl is not installed. Install it with: brew install flyctl',
        });
      }

      // 11. Find or generate fly.toml for the deploy command
      const flyTomlTemplateCandidates = [
        path.join(PROJECT_DIR, 'node_modules', 'gentyr', 'infra', 'fly-playwright', 'fly.toml.template'),
        path.join(PROJECT_DIR, 'infra', 'fly-playwright', 'fly.toml.template'),
      ];
      const flyTomlTemplate = flyTomlTemplateCandidates.find(p => fs.existsSync(p));
      let flyTomlPath: string;
      if (flyTomlTemplate) {
        // Generate fly.toml from template with app name substituted
        const tomlContent = fs.readFileSync(flyTomlTemplate, 'utf-8')
          .replace(/\$\{?APP_NAME\}?/g, flySection.appName);
        flyTomlPath = path.join(os.tmpdir(), `fly-project-image-${Date.now()}.toml`);
        fs.writeFileSync(flyTomlPath, tomlContent);
      } else {
        return JSON.stringify({
          success: false,
          message: 'Could not find fly.toml.template. Ensure GENTYR is installed.',
        });
      }

      // 12. Build deploy command with build args
      const imageLabel = `project-${gitShortSha}`;
      const buildArgs = [
        'deploy',
        '--app', flySection.appName,
        '--config', flyTomlPath,
        '--dockerfile', dockerfilePath,
        '--build-arg', `BASE_IMAGE=${baseImageTag}`,
        '--build-arg', `GIT_REMOTE=${gitRemote}`,
        '--build-arg', `GIT_REF=${gitRef}`,
        '--remote-only',
        '--image-label', imageLabel,
      ];
      if (gitAuthToken) {
        buildArgs.push('--build-arg', `GIT_TOKEN=${gitAuthToken}`);
      }
      if (args.build_cmd) {
        buildArgs.push('--build-arg', `BUILD_CMD=${args.build_cmd}`);
      }

      // 13. Spawn in background (takes 5-15 minutes for remote build with install)
      const logFile = path.join(PROJECT_DIR, '.claude', 'state', `fly-project-deploy-${Date.now()}.log`);
      fs.mkdirSync(path.dirname(logFile), { recursive: true });

      const logFd = fs.openSync(logFile, 'w');
      const child = spawn('flyctl', buildArgs, {
        cwd: path.dirname(dockerfilePath),
        env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT_DIR },
        detached: true,
        stdio: ['ignore', logFd, logFd],
      });
      child.unref();
      fs.closeSync(logFd);

      // 14. Store project image metadata for staleness detection
      const metaPath = path.join(PROJECT_DIR, '.claude', 'state', 'fly-project-image-metadata.json');
      try {
        const metadata = {
          deployedAt: new Date().toISOString(),
          deploying: true,
          gitSha: gitShortSha,
          gitRef,
          lockfileHash,
          baseImageTag,
          imageLabel,
          appName: flySection.appName,
        };
        fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2) + '\n');
      } catch { /* non-fatal */ }

      // 15. Set up a background watcher to update metadata when deploy completes
      if (child.pid) {
        const watcherScript = `
          while kill -0 ${child.pid} 2>/dev/null; do sleep 5; done
          EXIT_CODE=$(wait ${child.pid} 2>/dev/null; echo $?)
          if [ "$EXIT_CODE" = "0" ] 2>/dev/null; then
            node -e "
              const fs = require('fs');
              const p = '${metaPath.replace(/'/g, "\\'")}';
              try {
                const m = JSON.parse(fs.readFileSync(p, 'utf-8'));
                m.deploying = false;
                m.deployCompletedAt = new Date().toISOString();
                fs.writeFileSync(p, JSON.stringify(m, null, 2) + '\\n');
              } catch {}
            "
          fi
        `;
        const watcher = spawn('bash', ['-c', watcherScript], {
          detached: true,
          stdio: 'ignore',
        });
        watcher.unref();
      }

      return JSON.stringify({
        success: true,
        deploying: true,
        pid: child.pid,
        appName: flySection.appName,
        baseImage: baseImageTag,
        gitRef,
        gitSha: gitShortSha,
        imageLabel,
        lockfileHash: lockfileHash || '<not computed>',
        logFile,
        message: `Deploying project image to ${flySection.appName} in background (PID ${child.pid}). ` +
          `This takes 5-15 minutes (clone + pnpm install + browser install). ` +
          `Poll get_fly_status() to check when projectImageDeployed becomes true. ` +
          `After deploy completes, enable with: update_services_config({ updates: { fly: { projectImageEnabled: true } } }). ` +
          `Deploy log: ${logFile}`,
      });
    },
  },
  {
    name: 'set_fly_machine_ram',
    description:
      'Set RAM allocation for Fly.io remote demo machines. Two independent settings: headless (default 2048MB, ~900MB needed) ' +
      'and headed with video recording (default 4096MB, ~2GB needed). Takes effect immediately on the next run_demo — no sync or restart required.',
    schema: SetFlyMachineRamArgsSchema,
    handler: async (args: SetFlyMachineRamArgs) => {
      const current = readFlyMachineConfig();
      if (args.machineRamHeadless !== undefined) current.machineRamHeadless = args.machineRamHeadless;
      if (args.machineRamHeaded !== undefined) current.machineRamHeaded = args.machineRamHeaded;
      writeFlyMachineConfig(current);
      return JSON.stringify({
        success: true,
        machineRamHeadless: current.machineRamHeadless,
        machineRamHeaded: current.machineRamHeaded,
        message: `Fly.io machine RAM updated. Headless: ${current.machineRamHeadless}MB, Headed: ${current.machineRamHeaded}MB. Takes effect on next run_demo.`,
      });
    },
  },
  {
    name: 'get_fly_machine_ram',
    description: 'Get current RAM allocation settings for Fly.io remote demo machines.',
    schema: GetFlyMachineRamArgsSchema,
    handler: async (_args: GetFlyMachineRamArgs) => {
      const config = readFlyMachineConfig();
      return JSON.stringify(config);
    },
  },
  {
    name: 'get_fly_logs',
    description:
      'Retrieve recent Fly.io app logs for the demo execution machines. ' +
      'Shows machine lifecycle events, process output, crash reasons, and SIGTERM sources. ' +
      'Essential for diagnosing why remote demo machines die unexpectedly.',
    schema: GetFlyLogsArgsSchema,
    handler: async (args: GetFlyLogsArgs) => {
      const flySection = getFlyConfigFromServices();
      if (!flySection || !flySection.appName) {
        return JSON.stringify({ error: 'Fly.io not configured' });
      }
      try {
        const cmdArgs = ['logs', '--app', flySection.appName, '--no-tail', '-n', String(args.lines)];
        if (args.machine_id) {
          cmdArgs.push('--instance', args.machine_id);
        }
        const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          execFile('fly', cmdArgs, { encoding: 'utf-8', timeout: 15000 }, (err, stdout, stderr) => {
            if (err && !stdout) reject(err);
            else resolve({ stdout: stdout || '', stderr: stderr || '' });
          });
        });
        return JSON.stringify({
          app: flySection.appName,
          lines: args.lines,
          machine_id: args.machine_id || 'all',
          logs: stdout.trim(),
          ...(stderr ? { warnings: stderr.trim() } : {}),
        });
      } catch (err) {
        return JSON.stringify({
          error: `Failed to retrieve logs: ${err instanceof Error ? err.message : String(err)}`,
          hint: 'Ensure flyctl is installed and authenticated (fly auth login)',
        });
      }
    },
  },
  // ── Steel.dev Cloud Browser Tools ──
  {
    name: 'steel_health_check',
    description:
      'Check Steel.dev cloud browser configuration, API connectivity, and active sessions. ' +
      'Shows whether Steel is configured in services.json, API key resolves, API is reachable, ' +
      'active session count, and extension deployment status. Analogous to get_fly_status for Steel.',
    schema: SteelHealthCheckArgsSchema,
    handler: async (_args: SteelHealthCheckArgs) => {
      const steelSection = getSteelConfigFromServices();
      if (!steelSection) {
        return JSON.stringify({
          configured: false,
          message: 'Steel.dev not configured. Add a "steel" section to services.json via update_services_config.',
        });
      }
      if (!steelSection.enabled) {
        return JSON.stringify({
          configured: true,
          enabled: false,
          message: 'Steel.dev is configured but disabled. Set steel.enabled=true in services.json.',
        });
      }

      // Resolve API key
      let apiKey: string;
      try {
        const { resolved, failedKeys, failureDetails } = resolveOpReferencesStrict({ STEEL_API_KEY: steelSection.apiKey });
        if (failedKeys.length > 0) {
          return JSON.stringify({
            configured: true,
            enabled: true,
            healthy: false,
            message: `STEEL_API_KEY credential resolution failed: ${failureDetails['STEEL_API_KEY'] || 'unknown error'}`,
          });
        }
        apiKey = resolved['STEEL_API_KEY'];
      } catch {
        return JSON.stringify({
          configured: true,
          enabled: true,
          healthy: false,
          message: 'Failed to resolve STEEL_API_KEY from 1Password',
        });
      }

      // Health check + list sessions
      let healthy = false;
      let activeSessions: Array<{ sessionId: string; status: string; createdAt: string }> = [];
      try {
        const { checkSteelHealth: checkHealth } = await import('./execution-target.js');
        healthy = await checkHealth(apiKey, 5000);
        if (healthy) {
          const { listActiveSteelSessions } = await import('./steel-runner.js');
          activeSessions = await listActiveSteelSessions({ apiKey, orgId: steelSection.orgId });
        }
      } catch { /* non-fatal */ }

      return JSON.stringify({
        configured: true,
        enabled: true,
        healthy,
        activeSessions: activeSessions.length,
        maxConcurrentSessions: steelSection.maxConcurrentSessions ?? 2,
        extensionId: steelSection.extensionId ?? null,
        proxyConfig: steelSection.proxyConfig ?? null,
        defaultTimeout: steelSection.defaultTimeout ?? 300000,
      });
    },
  },
  {
    name: 'upload_steel_extension',
    description:
      'Upload a Chrome extension (ZIP or CRX) to Steel.dev for use in stealth demo scenarios. ' +
      'Extensions are stored at the org level — upload once, use in many sessions. ' +
      'The returned extension ID is saved to services.json steel.extensionId. ' +
      'The target project builds the extension; this tool just uploads it.',
    schema: UploadSteelExtensionArgsSchema,
    handler: async (args: UploadSteelExtensionArgs) => {
      const steelSection = getSteelConfigFromServices();
      if (!steelSection || !steelSection.enabled) {
        return JSON.stringify({ error: 'Steel.dev not configured or disabled. Add/enable "steel" in services.json first.' });
      }

      if (!args.force && steelSection.extensionId) {
        return JSON.stringify({
          message: `Extension already uploaded (ID: ${steelSection.extensionId}). Use force=true to re-upload.`,
          extensionId: steelSection.extensionId,
        });
      }

      // Resolve API key
      let apiKey: string;
      try {
        const { resolved, failedKeys } = resolveOpReferencesStrict({ STEEL_API_KEY: steelSection.apiKey });
        if (failedKeys.length > 0) {
          return JSON.stringify({ error: 'STEEL_API_KEY credential resolution failed.' });
        }
        apiKey = resolved['STEEL_API_KEY'];
      } catch {
        return JSON.stringify({ error: 'Failed to resolve STEEL_API_KEY from 1Password.' });
      }

      // Resolve ZIP path
      const zipPath = path.isAbsolute(args.zip_path) ? args.zip_path : path.join(PROJECT_DIR, args.zip_path);
      if (!fs.existsSync(zipPath)) {
        return JSON.stringify({ error: `Extension file not found: ${zipPath}` });
      }

      try {
        const { uploadSteelExtension: upload } = await import('./steel-runner.js');
        const result = await upload({ apiKey, orgId: steelSection.orgId }, zipPath);

        // Persist extension ID to services.json via atomic write pattern
        // (best-effort — may be root-owned)
        try {
          const servicesPath = path.join(PROJECT_DIR, '.claude', 'config', 'services.json');
          if (fs.existsSync(servicesPath)) {
            const services = JSON.parse(fs.readFileSync(servicesPath, 'utf-8'));
            if (services.steel) {
              services.steel.extensionId = result.extensionId;
              const { safeWriteJson } = await import('../shared/safe-json-io.js');
              safeWriteJson(servicesPath, services);
            }
          }
        } catch {
          // If services.json is root-owned, the agent can update via update_services_config
        }

        return JSON.stringify({
          success: true,
          extensionId: result.extensionId,
          message: `Extension uploaded to Steel.dev. ID: ${result.extensionId}`,
        });
      } catch (err) {
        return JSON.stringify({
          error: `Upload failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  },
];

// Crash-safe persistence: if the server crashes, persist the latest demo state
// so check_demo_result on restart can recover diagnostics instead of "unknown".
process.on('uncaughtException', (err) => {
  process.stderr.write(`[playwright] Uncaught exception: ${err.message}\n${err.stack}\n`);
  try { persistDemoRuns(); } catch { /* last resort */ }
  process.exit(1);
});

const server = new McpServer({
  name: 'playwright',
  version: '1.0.0',
  tools,
});

server.start();
