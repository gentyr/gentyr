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
import { spawn, execFile, execFileSync } from 'child_process';
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
} from './types.js';
import { parseTestOutput, truncateOutput, validateExtraEnv } from './helpers.js';
import { discoverPlaywrightConfig } from './config-discovery.js';
import { findTraceZip, parseTraceZip } from './trace-parser.js';

// ============================================================================
// Configuration
// ============================================================================

const PROJECT_DIR = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const WORKTREE_DIR = process.env.CLAUDE_WORKTREE_DIR || null;
/** Where source code + builds live: worktree if set, otherwise main tree */
const EFFECTIVE_CWD = WORKTREE_DIR ? path.resolve(WORKTREE_DIR) : PROJECT_DIR;
const pwConfig = discoverPlaywrightConfig(EFFECTIVE_CWD);
const REPORT_DIR = path.join(PROJECT_DIR, 'playwright-report');

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
const demoAutoKillTimers = new Map<number, ReturnType<typeof setTimeout>>();
const DEMO_AUTO_KILL_MS = 60_000;
// Milliseconds to wait after detecting suite_end before sending SIGTERM (technical flush buffer).
// success_pause_ms is additive on top of this.
const SUITE_END_KILL_DELAY_MS = 5_000;
// PIDs that were auto-killed after a suite_end event — treated as 'passed' by the exit handler.
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
      .map(({ trace_summary, progress_file, stdout_tail, screenshot_interval, suite_end_detected_at, interrupt_detected_at, ...rest }) => rest);
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
 * Called from stopDemo and autoKillDemo when cleaning up an interrupted demo.
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
 * Auto-kill a demo process that hasn't been polled within DEMO_AUTO_KILL_MS.
 * Prevents orphaned browser processes when the polling agent stops.
 */
function autoKillDemo(pid: number): void {
  demoAutoKillTimers.delete(pid);
  const entry = demoRuns.get(pid);
  if (!entry || (entry.status !== 'running' && entry.status !== 'interrupted')) return;

  // Exit fullscreen before teardown
  if (entry.fullscreened) {
    void unfullscreenChromeWindow();
    entry.fullscreened = false;
  }

  const wasInterrupted = entry.status === 'interrupted';

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
    // Process may have already exited
  }

  if (!wasInterrupted) {
    entry.status = 'failed';
    entry.failure_summary = 'Auto-killed: no poll received within 60s';
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

  persistDemoRuns();

  // Release display lock if this demo auto-acquired it
  autoReleaseDisplayLockForPid(pid);
}

/**
 * Reset (or start) the auto-kill countdown for a demo process.
 * Called on run_demo launch and on each check_demo_result poll.
 */
function resetAutoKillTimer(pid: number): void {
  const existing = demoAutoKillTimers.get(pid);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => autoKillDemo(pid), DEMO_AUTO_KILL_MS);
  timer.unref(); // Don't prevent MCP process exit
  demoAutoKillTimers.set(pid, timer);
}

/**
 * Clear the auto-kill timer for a demo process (natural exit or manual stop).
 */
function clearAutoKillTimer(pid: number): void {
  const existing = demoAutoKillTimers.get(pid);
  if (existing) {
    clearTimeout(existing);
    demoAutoKillTimers.delete(pid);
  }
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
}): Record<string, string> {
  const env: Record<string, string> = { ...process.env as Record<string, string> };

  // Strip infrastructure credentials from child env (unconditional)
  for (const key of INFRA_CRED_KEYS) delete env[key];

  // Resolve 1Password secrets for child process (fail-closed: missing credentials = abort)
  try {
    const config = loadServicesConfig(PROJECT_DIR);
    const { resolvedEnv, failedKeys } = resolveLocalSecrets(config);
    Object.assign(env, resolvedEnv);

    if (failedKeys.length > 0) {
      throw new Error(`Failed to resolve credentials: ${failedKeys.join(', ')}. Check OP_SERVICE_ACCOUNT_TOKEN and 1Password connectivity.`);
    }

    // Apply project-specific dev-mode env when dev server is running
    if (opts.dev_server_ready && config.demoDevModeEnv) {
      Object.assign(env, config.demoDevModeEnv);
    }
  } catch (err) {
    // Re-throw to caller — launching with missing credentials wastes sessions
    throw err;
  }

  if (opts.progress_file) env.DEMO_PROGRESS_FILE = opts.progress_file;
  if (opts.slow_mo !== undefined) env.DEMO_SLOW_MO = String(opts.slow_mo);
  if (opts.headless) env.DEMO_HEADLESS = '1';
  if (opts.base_url) env.PLAYWRIGHT_BASE_URL = opts.base_url;

  // Always show cursor dot in headed demos
  env.DEMO_SHOW_CURSOR = '1';

  // Maximize browser window in headed demos for cleaner recordings
  if (!opts.headless) env.DEMO_MAXIMIZE = '1';

  // Pass through port env vars from worktree allocation
  if (process.env.PLAYWRIGHT_WEB_PORT) env.PLAYWRIGHT_WEB_PORT = process.env.PLAYWRIGHT_WEB_PORT;
  if (process.env.PLAYWRIGHT_BACKEND_PORT) env.PLAYWRIGHT_BACKEND_PORT = process.env.PLAYWRIGHT_BACKEND_PORT;
  if (process.env.PLAYWRIGHT_BRIDGE_PORT) env.PLAYWRIGHT_BRIDGE_PORT = process.env.PLAYWRIGHT_BRIDGE_PORT;

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
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        exited = true;
        break;
      }
      const spinEnd = Date.now() + 200;
      while (Date.now() < spinEnd) { /* spin */ }
    }

    if (!exited) {
      // Process still alive at deadline — SIGKILL corrupts the MP4 (no moov atom)
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

/**
 * Fullscreen a Chrome for Testing window via AppleScript AXFullScreen.
 * Creates a new macOS Space automatically.
 */
async function fullscreenChromeWindow(): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  try {
    await execFileAsync('osascript', ['-e',
      'tell application "System Events" to tell process "Google Chrome for Testing" ' +
      'to set value of attribute "AXFullScreen" of window 1 to true'
    ], { timeout: 5000 });
    return true;
  } catch { return false; }
}

/**
 * Exit fullscreen for Chrome for Testing window.
 */
async function unfullscreenChromeWindow(): Promise<void> {
  if (process.platform !== 'darwin') return;
  try {
    await execFileAsync('osascript', ['-e',
      'tell application "System Events" to tell process "Google Chrome for Testing" ' +
      'to set value of attribute "AXFullScreen" of window 1 to false'
    ], { timeout: 5000 });
  } catch { /* non-fatal */ }
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

  // Pre-flight validation (fast credential check, no I/O)
  const preflight = validatePrerequisites();
  if (!preflight.ok) {
    return {
      success: false,
      project,
      message: `Environment validation failed:\n${preflight.errors.map(e => `  - ${e}`).join('\n')}`,
      context: `PROJECT_DIR=${PROJECT_DIR}, EFFECTIVE_CWD=${EFFECTIVE_CWD}`,
    };
  }

  const webPort = process.env.PLAYWRIGHT_WEB_PORT || '3000';
  const devServerUrl = base_url || `http://localhost:${webPort}`;

  // Execute registered prerequisites FIRST — this starts the dev server if registered as a background prereq
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

  // Worktree freshness gate — auto-sync or block stale demos
  const freshness = checkAndSyncWorktree();
  if (!freshness.fresh) {
    return {
      success: false,
      project,
      message: `Worktree stale: ${freshness.message}`,
      context: `PROJECT_DIR=${PROJECT_DIR}, EFFECTIVE_CWD=${EFFECTIVE_CWD}`,
    };
  }

  // Verify dev server is healthy (fallback auto-start if no prerequisite handled it)
  const devServer = await ensureDevServer(devServerUrl);
  if (!devServer.ready) {
    return {
      success: false,
      project,
      message: `Dev server not ready after prerequisites: ${devServer.message}. Register: register_prerequisite({ command: "pnpm dev", scope: "global", run_as_background: true, health_check: "curl -sf http://localhost:\${PORT:-3000}" }). Use \${PORT:-3000} for worktree compatibility. Do NOT manually call secret_dev_server_start — run_demo handles dev server lifecycle automatically.`,
      context: `PROJECT_DIR=${PROJECT_DIR}, EFFECTIVE_CWD=${EFFECTIVE_CWD}`,
    };
  }
  const effectiveBaseUrl = devServerUrl;

  // Display lock guard for headed demos — serialize to prevent window capture conflicts.
  // When headless=false, require the caller to hold the display lock.
  // If they don't hold it, attempt to auto-acquire; if another agent holds it, reject.
  let displayLockAutoAcquired = false;
  if (!args.headless) {
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
          const row = feedbackDb.prepare('SELECT env_vars, test_file FROM demo_scenarios WHERE id = ?').get(args.scenario_id) as { env_vars: string | null; test_file: string | null } | undefined;
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
    const { resolved: resolvedScenarioEnv, failedKeys: scenarioFailedKeys } = resolveOpReferencesStrict(scenarioEnvVars);
    if (scenarioFailedKeys.length > 0) {
      return {
        success: false,
        project,
        message: `Credential resolution failed for scenario env vars: ${scenarioFailedKeys.join(', ')}. Check OP_SERVICE_ACCOUNT_TOKEN and 1Password connectivity.`,
      };
    }
    scenarioEnvVars = resolvedScenarioEnv;
  }

  // Merge env_vars: scenario env_vars as base, explicit extra_env overrides
  const mergedExtraEnv = { ...scenarioEnvVars, ...args.extra_env };

  // Validate extra_env before building the environment
  if (Object.keys(mergedExtraEnv).length > 0) {
    const validationError = validateExtraEnv(mergedExtraEnv);
    if (validationError) {
      return { success: false, project, message: validationError };
    }
  }

  // Fix 4: Generate progress file path for real-time progress reporting
  const progressId = crypto.randomBytes(4).toString('hex');
  const progressFilePath = path.join(PROJECT_DIR, '.claude', 'state', `demo-progress-${progressId}.jsonl`);

  let env: Record<string, string>;
  try {
    env = buildDemoEnv({
      slow_mo,
      headless: args.headless,
      base_url: effectiveBaseUrl,
      trace: args.trace,
      extra_env: Object.keys(mergedExtraEnv).length > 0 ? mergedExtraEnv : undefined,
      progress_file: progressFilePath,
      dev_server_ready: devServer.ready,
    });
  } catch (err) {
    return {
      success: false,
      project,
      message: `Credential resolution failed: ${err instanceof Error ? err.message : String(err)}`,
    };
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
  // (fullscreen must happen after Chrome appears but before recording starts)
  let windowRecorder: { pid: number; process: ReturnType<typeof spawn> } | null = null;
  let windowRecordingPath: string | null = null;
  let screenshotCapture: { interval: ReturnType<typeof setInterval>; dir: string; startTime: number } | null = null;
  let fullscreened = false;
  const shouldRecord = !args.headless && !args.skip_recording;

  try {
    const child = spawn('npx', cmdArgs, {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: EFFECTIVE_CWD,
      env,
    });

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

    // For headed recording: wait for Chrome, fullscreen it, then start recording
    if (shouldRecord) {
      const recorderBinary = getWindowRecorderBinary();
      if (recorderBinary) {
        const chromeReady = await waitForChromeWindow(30000);
        if (chromeReady) {
          fullscreened = await fullscreenChromeWindow();
          if (fullscreened) {
            // Wait for fullscreen animation to complete
            await new Promise(r => setTimeout(r, 1000));
          }
        }
        windowRecordingPath = path.join(PROJECT_DIR, '.claude', 'state', `demo-window-${progressId}.mp4`);
        windowRecorder = startWindowRecorder(windowRecordingPath, 'Chrome for Testing');
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
    const GRACE_MS = 90_000;
    const STALL_MS = Math.max(90_000, (args.timeout ?? 120000) > 120000 ? (args.timeout ?? 120000) / 2 : 90_000);
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
    };
    if (windowRecorder) {
      demoState.window_recorder_pid = windowRecorder.pid;
      demoState.window_recording_path = windowRecordingPath ?? undefined;
    }
    demoState.fullscreened = fullscreened;
    if (screenshotCapture) {
      demoState.screenshot_interval = screenshotCapture.interval;
      demoState.screenshot_dir = screenshotCapture.dir;
      demoState.screenshot_start_time = screenshotCapture.startTime;
    }
    demoRuns.set(demoPid, demoState);
    persistDemoRuns();

    if (displayLockAutoAcquired) {
      displayLockAutoAcquiredPids.add(demoPid);
    }

    // ── Background stall/suite_end/interrupt monitoring (fire-and-forget) ──
    // Continues running after runDemo returns. Cleaned up on child exit.
    const bgMonitorStart = Date.now();
    const INTERRUPT_GRACE_MS = 3_000; // 3s grace for test to wind down after interrupt
    const bgMonitorInterval = setInterval(() => {
      readNewProgressEvents();

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

          // Exit fullscreen
          if (intEntry.fullscreened) {
            void unfullscreenChromeWindow();
            intEntry.fullscreened = false;
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

      // Stall detection (only after grace period)
      if (Date.now() - bgMonitorStart >= GRACE_MS) {
        const lastActivity = Math.max(lastProgressAt, lastProgressEventAt);
        const silenceMs = Date.now() - lastActivity;
        if (silenceMs >= STALL_MS) {
          clearInterval(bgMonitorInterval);
          const entry = demoRuns.get(demoPid);
          if (entry && entry.status === 'running') {
            entry.failure_summary = `Stalled: no progress for ${Math.round(STALL_MS / 1000)}s after ${Math.round(GRACE_MS / 1000)}s grace period. Last output: ${lastOutputLine || '(none)'}`;
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
      clearAutoKillTimer(demoPid);
      const entry = demoRuns.get(demoPid);
      if (!entry) return;

      // If already finalized (suite_end_killed via check_demo_result, autoKillDemo, interrupt, etc.), skip
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

      if (entry.fullscreened) {
        void unfullscreenChromeWindow();
        entry.fullscreened = false;
      }

      entry.ended_at = new Date().toISOString();
      entry.exit_code = code ?? undefined;
      entry.stdout_tail = stdoutLines.join('\n').slice(0, 5000);

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
        };
      }

      return {
        success: false,
        project,
        message: `Playwright process crashed during startup (exit code: ${earlyExit.code}, signal: ${earlyExit.signal})${stdout ? `\nstdout: ${stdout.slice(0, 2000)}` : ''}${snippet ? `\nstderr: ${snippet}` : ''}`,
      };
    }

    // ── Process still running — detach and return PID for polling ──
    if (child.stdout) {
      child.stdout.removeAllListeners('data');
      child.stdout.resume();
    }
    if (child.stderr) {
      child.stderr.removeAllListeners('data');
      child.stderr.resume();
    }
    child.unref();
    resetAutoKillTimer(demoPid);

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
    if (windowRecorder) {
      recordingStatus = ' Video recording active.';
    } else if (args.headless) {
      recordingStatus = ' No video recording (headless mode).';
    } else {
      recordingStatus = args.skip_recording
        ? ' No video recording (recording skipped).'
        : ' No video recording (window recorder unavailable).';
    }

    return {
      success: true,
      project,
      message: `Demo launched for project "${project}" with ${slow_mo}ms slow motion.${effectiveTestFile ? ` Running file: ${effectiveTestFile}.` : ''} Use check_demo_result with PID ${demoPid} to monitor.${recordingStatus}${warningText}${recorderInfo}`,
      pid: child.pid,
      slow_mo,
      test_file: effectiveTestFile,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      project,
      message: `Failed to launch headed demo: ${message}`,
    };
  }
}

/**
 * Read and parse the JSONL progress file to build a DemoProgress snapshot.
 */
function readDemoProgress(progressFilePath: string): DemoProgress | null {
  try {
    if (!fs.existsSync(progressFilePath)) return null;
    const content = fs.readFileSync(progressFilePath, 'utf-8');
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
 * Check the result of a previously launched demo run.
 * Reads from the in-memory tracking map (primary) or persisted state file (after MCP restart).
 */
function checkDemoResult(args: CheckDemoResultArgs): CheckDemoResultResult {
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

  // Interrupted demos: browser is alive for user interaction
  if (entry.status === 'interrupted') {
    resetAutoKillTimer(pid);
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
            resetAutoKillTimer(pid);
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
        // Exit fullscreen before teardown
        if (entry.fullscreened) {
          void unfullscreenChromeWindow();
          entry.fullscreened = false;
        }
        // Suite done — stop window recorder first (sync), then kill playwright process
        let recorderClean = false;
        if (entry.window_recorder_pid && entry.window_recording_path) {
          recorderClean = stopWindowRecorderSync(entry.window_recorder_pid, entry.window_recording_path);
          entry.window_recorder_pid = undefined;
        }

        clearAutoKillTimer(pid);
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
          message: entry.status === 'passed'
            ? `Demo completed successfully in ${durationSec}s (auto-killed after suite completion).${degradedSuffix}`
            : `Demo failed in ${durationSec}s — ${entry.failure_summary}. Auto-killed after suite completion.`,
        };
      }

      // Suite still running — reset auto-kill countdown
      resetAutoKillTimer(pid);
    } catch {
      // Process no longer exists but we didn't get the exit event (e.g., MCP restarted, user closed browser)
      clearAutoKillTimer(pid);
      entry.ended_at = new Date().toISOString();

      // Exit fullscreen before teardown (may fail if process already dead — non-fatal)
      if (entry.fullscreened) {
        void unfullscreenChromeWindow();
        entry.fullscreened = false;
      }

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
    message,
  };
}

/**
 * Stop a running demo by PID.
 * Kills the process group and returns the final progress snapshot.
 */
function stopDemo(args: StopDemoArgs): StopDemoResult {
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
    // Exit fullscreen before teardown
    if (entry.fullscreened) {
      void unfullscreenChromeWindow();
      entry.fullscreened = false;
    }
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

  // Cancel auto-kill — manual stop takes over
  clearAutoKillTimer(pid);

  // Read final progress snapshot before killing
  const progress = entry.progress_file ? readDemoProgress(entry.progress_file) : null;

  // Exit fullscreen before teardown
  if (entry.fullscreened) {
    void unfullscreenChromeWindow();
    entry.fullscreened = false;
  }

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

  // 0. Prerequisites (run FIRST — may start the dev server)
  const preflightBaseUrl = args.base_url || `http://localhost:${process.env.PLAYWRIGHT_WEB_PORT || '3000'}`;
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

  // 0.5. Worktree freshness (auto-sync if possible)
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
const demoBatchAutoKillTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DEMO_BATCH_AUTO_KILL_MS = 120_000; // 2 min between polls

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

function autoKillBatch(batchId: string): void {
  demoBatchAutoKillTimers.delete(batchId);
  const state = demoBatches.get(batchId);
  if (!state || state.status !== 'running') return;

  if (state.current_pid) {
    try { process.kill(-state.current_pid, 'SIGTERM'); } catch { /* already dead */ }
  }

  state.status = 'stopped';
  state.ended_at = new Date().toISOString();
  // Mark remaining pending scenarios as skipped
  for (const s of state.scenarios) {
    if (s.status === 'pending' || s.status === 'running') s.status = 'skipped';
  }
  state.progress.skipped = state.scenarios.filter(s => s.status === 'skipped').length;
  persistDemoBatches();
}

function resetBatchAutoKillTimer(batchId: string): void {
  const existing = demoBatchAutoKillTimers.get(batchId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => autoKillBatch(batchId), DEMO_BATCH_AUTO_KILL_MS);
  timer.unref();
  demoBatchAutoKillTimers.set(batchId, timer);
}

function clearBatchAutoKillTimer(batchId: string): void {
  const existing = demoBatchAutoKillTimers.get(batchId);
  if (existing) {
    clearTimeout(existing);
    demoBatchAutoKillTimers.delete(batchId);
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
          const { resolved, failedKeys } = resolveOpReferencesStrict(parsed);
          envVars = resolved;
          if (failedKeys.length > 0) {
            credentialWarnings = failedKeys.map(k => `Failed to resolve credential: ${k}`);
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
 * Run a batch of demo scenarios sequentially.
 * Each batch gets its own output directory to prevent Playwright's cleanup from destroying previous recordings.
 */
async function runBatchSequence(state: DemoBatchState, args: RunDemoBatchArgs, scenarioEnvMap?: Map<string, Record<string, string>>, devServerReady?: boolean, effectiveBaseUrl?: string): Promise<void> {
  const batchSize = args.batch_size ?? 5;
  const scenarios = state.scenarios;
  const totalBatches = Math.ceil(scenarios.length / batchSize);

  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    // Check if stopped
    if (state.status !== 'running') break;

    state.progress.current_batch = batchIdx + 1;
    const batchStart = batchIdx * batchSize;
    const batchEnd = Math.min(batchStart + batchSize, scenarios.length);
    const batchScenarios = scenarios.slice(batchStart, batchEnd);

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
    try {
      const exitResult = await new Promise<{ code: number | null }>((resolve) => {
        const child = spawn('npx', cmdArgs, {
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: EFFECTIVE_CWD,
          env,
        });

        if (!child.pid) {
          resolve({ code: 1 });
          return;
        }

        state.current_pid = child.pid;
        persistDemoBatches();

        child.stdout?.resume();
        child.stderr?.resume();

        child.on('exit', (code) => {
          resolve({ code });
        });

        child.on('error', () => {
          resolve({ code: 1 });
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

      // Map results back to scenarios using per-file results
      for (const s of batchScenarios) {
        const fileResult = fileResultMap.get(path.basename(s.test_file));
        if (fileResult) {
          s.status = fileResult;
        } else {
          // No progress event for this file — use exit code as fallback
          s.status = exitResult.code === 0 ? 'passed' : 'failed';
        }

        if (s.status === 'failed') {
          s.failure_summary = progress?.recent_errors?.[0]?.slice(0, 500) ?? `Exit code: ${exitResult.code}`;
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

  clearBatchAutoKillTimer(state.batch_id);
  persistDemoBatches();
}

/**
 * Start a batch demo run.
 * Discovers scenarios, partitions into batches, and runs them sequentially in the background.
 */
async function runDemoBatch(args: RunDemoBatchArgs): Promise<string> {
  const batchWebPort = process.env.PLAYWRIGHT_WEB_PORT || '3000';
  const devServerUrl = args.base_url || `http://localhost:${batchWebPort}`;

  // Execute prerequisites FIRST — starts dev server if registered as background prereq
  const prereqResult = await executePrerequisites({ base_url: devServerUrl });
  if (!prereqResult.success) {
    return JSON.stringify({ error: `Prerequisites failed: ${prereqResult.message}. Run preflight_check to diagnose. Do NOT bypass by running Playwright directly.` });
  }

  // Worktree freshness gate — auto-sync or block stale demos
  const batchFreshness = checkAndSyncWorktree();
  if (!batchFreshness.fresh) {
    return JSON.stringify({ error: `Worktree stale: ${batchFreshness.message}` });
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
  const batchSize = args.batch_size ?? 5;
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
  resetBatchAutoKillTimer(batchId);

  // Start background execution (non-blocking)
  runBatchSequence(state, args, scenarioEnvMap, devServer.ready, effectiveBatchBaseUrl).catch((err) => {
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
    resetBatchAutoKillTimer(batch_id);
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

  return {
    status: state.status,
    batch_id,
    progress: { ...state.progress },
    scenarios: state.scenarios.map(s => ({ ...s })),
    message,
  };
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

  clearBatchAutoKillTimer(batch_id);
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

/** Get caller queue ID from env — falls back to null. */
function getCallerQueueId(): string | null {
  return process.env.CLAUDE_SESSION_ID || null;
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
      'Launch Playwright tests in a visible headed browser that runs automatically at human-watchable speed. ' +
      'No clicking required — tests play through on their own with configurable pace. ' +
      'VIDEO RECORDING: Headed mode always records video automatically (macOS, no extra args). ' +
      'Headless mode never records video. Scenario videos: `.claude/recordings/demos/{scenarioId}.mp4`. ' +
      'Best for presentations and demos. Supports headless mode (headless: true) for CI or screenshot capture. ' +
      'Cursor dot is always visible in headed mode. The target project\'s playwright.config.ts must read ' +
      'parseInt(process.env.DEMO_SLOW_MO || "0") in use.launchOptions.slowMo for pace control to work. ' +
      'Video uses ScreenCaptureKit window recorder — do NOT set DEMO_RECORD_VIDEO. ' +
      'Prerequisites (including dev server start) execute automatically if registered via register_prerequisite. ' +
      'If this tool fails on prerequisites, run preflight_check to diagnose — do NOT bypass by running Playwright directly via Bash or secret_run_command.',
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
      'Auto-kill: demo processes are automatically killed if this tool is not called within 60 seconds. ' +
      'Each poll resets the countdown. Prevents orphaned browser processes when the polling agent stops. ' +
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
      'Run multiple demo scenarios in sequential batches. ' +
      'Defaults: headless=true, batch_size=5. No video recording in batch mode. ' +
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
      'Auto-kill: batch runs are stopped if not polled within 2 minutes. Each poll resets the countdown.',
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
];

const server = new McpServer({
  name: 'playwright',
  version: '1.0.0',
  tools,
});

server.start();
