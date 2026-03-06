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
import { spawn, execFileSync } from 'child_process';
import { McpServer, type AnyToolHandler } from '../shared/server.js';
import { loadServicesConfig, resolveLocalSecrets, INFRA_CRED_KEYS, buildCleanEnv } from '../shared/op-secrets.js';
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
} from './types.js';
import { parseTestOutput, truncateOutput, validateExtraEnv } from './helpers.js';
import { discoverPlaywrightConfig } from './config-discovery.js';
import { findTraceZip, parseTraceZip } from './trace-parser.js';

// ============================================================================
// Configuration
// ============================================================================

const PROJECT_DIR = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const pwConfig = discoverPlaywrightConfig(PROJECT_DIR);
const REPORT_DIR = path.join(PROJECT_DIR, 'playwright-report');
const RUN_TIMEOUT = 300_000; // 5 minutes for test runs

// ============================================================================
// Demo Run Tracking
// ============================================================================

const DEMO_RUNS_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'demo-runs.json');
const demoRuns = new Map<number, DemoRunState>();
const demoAutoKillTimers = new Map<number, ReturnType<typeof setTimeout>>();
const DEMO_AUTO_KILL_MS = 60_000;
// PIDs that were auto-killed after a suite_end event — treated as 'passed' by the exit handler.
const suiteEndAutoKilledPids = new Set<number>();

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
    const entries = [...demoRuns.values()]
      .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())
      .slice(0, 20)
      .map(({ trace_summary, progress_file, stdout_tail, ...rest }) => rest);
    fs.writeFileSync(DEMO_RUNS_PATH, JSON.stringify(entries, null, 2));
  } catch {
    // Non-fatal — state will be lost on MCP restart
  }
}

/**
 * Auto-kill a demo process that hasn't been polled within DEMO_AUTO_KILL_MS.
 * Prevents orphaned browser processes when the polling agent stops.
 */
function autoKillDemo(pid: number): void {
  demoAutoKillTimers.delete(pid);
  const entry = demoRuns.get(pid);
  if (!entry || entry.status !== 'running') return;

  // Kill the process group
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // Process may have already exited
  }

  entry.status = 'failed';
  entry.ended_at = new Date().toISOString();
  entry.failure_summary = 'Auto-killed: no poll received within 60s';

  // Clean up progress file
  if (entry.progress_file) {
    try { fs.unlinkSync(entry.progress_file); } catch { /* Non-fatal */ }
  }

  persistDemoRuns();
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

  return { ok: errors.length === 0, errors, warnings };
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
      cwd: PROJECT_DIR,
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
 * Launch Playwright tests in headed auto-play mode.
 * Runs tests in a visible browser at configurable speed via DEMO_SLOW_MO env var.
 * Validates prerequisites, spawns a detached process, and monitors for early crashes.
 */
async function runDemo(args: RunDemoArgs): Promise<RunDemoResult> {
  const { project, slow_mo, base_url, test_file, pause_at_end } = args;

  // Pre-flight validation
  const preflight = validatePrerequisites();
  if (!preflight.ok) {
    return {
      success: false,
      project,
      message: `Environment validation failed:\n${preflight.errors.map(e => `  - ${e}`).join('\n')}`,
    };
  }

  // Fix 4: Generate progress file path for real-time progress reporting
  const progressId = crypto.randomBytes(4).toString('hex');
  const progressFilePath = path.join(PROJECT_DIR, '.claude', 'state', `demo-progress-${progressId}.jsonl`);

  const cmdArgs = ['playwright', 'test', '--project', project];
  if (args.trace) {
    cmdArgs.push('--trace', 'on');
  }
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

  // Set progress file env var for the progress reporter
  env.DEMO_PROGRESS_FILE = progressFilePath;

  // Insert test_file as positional arg (after 'test', before '--project')
  if (test_file) {
    cmdArgs.splice(2, 0, test_file);
  }

  // Headed mode is the default for demos; headless opt-in disables it
  if (!args.headless) {
    cmdArgs.push('--headed');
  }

  // Per-test timeout (default 120s for demos)
  cmdArgs.push('--timeout', String(args.timeout ?? 120000));

  if (slow_mo !== undefined) {
    env.DEMO_SLOW_MO = String(slow_mo);
  }

  if (pause_at_end) {
    env.DEMO_PAUSE_AT_END = '1';
  }

  if (args.headless) {
    env.DEMO_HEADLESS = '1';
  }

  if (args.show_cursor) {
    env.DEMO_SHOW_CURSOR = '1';
  }

  if (args.record_video) {
    env.DEMO_RECORD_VIDEO = '1';
  }

  if (base_url) {
    env.PLAYWRIGHT_BASE_URL = base_url;
  }

  // Apply extra_env AFTER all explicit args so it cannot override them
  if (args.extra_env) {
    const validationError = validateExtraEnv(args.extra_env);
    if (validationError) {
      return { success: false, project, message: validationError };
    }
    Object.assign(env, args.extra_env);
  }

  try {
    const child = spawn('npx', cmdArgs, {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: PROJECT_DIR,
      env,
    });

    // Collect stderr for crash diagnostics and track progress
    let stderrChunks: Buffer[] = [];
    let lastProgressAt = Date.now();

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

    // Progress-based crash/stall detection:
    // - 60s startup grace period (no stall checks — browser + webServer boot is slow)
    // - After grace, check every 5s — if 90s silence (based on JSONL progress events, not
    //   raw stdout noise), kill and report stall
    // - Early exit during grace period is reported immediately
    // - Scale stall window for longer timeouts
    // - suite_end detection: when a suite_end JSONL event is detected, wait 5s then auto-kill
    //   the process group (gives user a moment to see the final state). Only applies in
    //   run_demo mode (not launch_ui_mode — which never uses a progress file).
    const GRACE_MS = 60_000;
    const STALL_MS = Math.max(90_000, (args.timeout ?? 120000) > 120000 ? (args.timeout ?? 120000) / 2 : 90_000);
    const SUITE_END_KILL_DELAY_MS = 5_000;
    const CHECK_INTERVAL_MS = 5_000;
    let lastOutputLine = '';
    // lastProgressEventAt tracks the timestamp of the last meaningful JSONL event
    // (test_begin, test_end, suite_begin, suite_end). Used for stall detection to avoid
    // false stalls caused by raw stdout/stderr noise (browser console chatter, etc.).
    let lastProgressEventAt = Date.now();
    // Byte offset into the progress file — incremented after each read to avoid
    // re-parsing the entire file on every stall check.
    let progressFileOffset = 0;
    // Timestamp when suite_end was detected in the JSONL file; null until then.
    let suiteEndDetectedAt: number | null = null;

    /**
     * Read new JSONL lines from the progress file since the last read offset.
     * Updates lastProgressEventAt and suiteEndDetectedAt as a side effect.
     * Returns the number of new meaningful events found.
     */
    const readNewProgressEvents = (): number => {
      try {
        if (!fs.existsSync(progressFilePath)) return 0;
        const stat = fs.statSync(progressFilePath);
        if (stat.size <= progressFileOffset) return 0;
        // Read only the new bytes since last check
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
        // Only advance offset to last complete line boundary to avoid losing partial lines
        const lastNewline = newText.lastIndexOf('\n');
        if (lastNewline === -1) {
          // No complete lines yet — rewind offset so we re-read next time
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
              event.type === 'suite_end'
            ) {
              lastProgressEventAt = Date.now();
              meaningfulEventCount++;
              if (event.type === 'suite_end' && suiteEndDetectedAt === null) {
                suiteEndDetectedAt = Date.now();
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

    const result = await new Promise<
      | { type: 'early_exit'; code: number | null; signal: string | null }
      | { type: 'stall' }
      | { type: 'suite_end_killed' }
      | { type: 'ok' }
    >(
      (resolve) => {
        let settled = false;
        let stallCheckInterval: ReturnType<typeof setInterval> | null = null;
        let graceTimer: ReturnType<typeof setTimeout> | null = null;
        let successTimer: ReturnType<typeof setTimeout> | null = null;

        const cleanup = () => {
          if (stallCheckInterval) clearInterval(stallCheckInterval);
          if (graceTimer) clearTimeout(graceTimer);
          if (successTimer) clearTimeout(successTimer);
        };

        // Start stall checking after the grace period
        graceTimer = setTimeout(() => {
          if (settled) return;
          stallCheckInterval = setInterval(() => {
            if (settled) { cleanup(); return; }

            // Read new JSONL events to update lastProgressEventAt and suiteEndDetectedAt
            readNewProgressEvents();

            // Auto-kill after suite_end + SUITE_END_KILL_DELAY_MS
            if (suiteEndDetectedAt !== null && Date.now() - suiteEndDetectedAt >= SUITE_END_KILL_DELAY_MS) {
              settled = true;
              cleanup();
              if (child.pid) {
                try { process.kill(-child.pid, 'SIGTERM'); } catch {}
              }
              resolve({ type: 'suite_end_killed' });
              return;
            }

            // Stall detection: use the more recent of raw output and JSONL progress events.
            // This prevents false stalls from processes that emit browser console chatter
            // but no meaningful test progress events.
            const lastActivity = Math.max(lastProgressAt, lastProgressEventAt);
            const silenceMs = Date.now() - lastActivity;
            if (silenceMs >= STALL_MS) {
              settled = true;
              cleanup();
              if (child.pid) {
                try { process.kill(-child.pid, 'SIGTERM'); } catch {}
              }
              resolve({ type: 'stall' });
            }
          }, CHECK_INTERVAL_MS);
        }, GRACE_MS);

        // Return success once past grace + first stall check window
        successTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve({ type: 'ok' });
        }, GRACE_MS + STALL_MS);

        child.on('exit', (code, signal) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve({ type: 'early_exit', code, signal });
        });

        child.on('error', (err) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve({ type: 'early_exit', code: 1, signal: err.message });
        });
      }
    );

    if (result.type === 'early_exit') {
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      const snippet = stderr.length > 2000 ? stderr.slice(0, 2000) + '...' : stderr;
      const stdout = stdoutLines.join('\n').trim();

      // Write crash event to progress file so check_demo_result can surface the error
      try {
        fs.mkdirSync(path.dirname(progressFilePath), { recursive: true });
        const crashEvent = {
          type: 'crash',
          timestamp: new Date().toISOString(),
          exit_code: result.code,
          signal: result.signal,
          stderr_snippet: stderr.slice(0, 5000),
          stdout_snippet: stdout.slice(0, 5000),
        };
        fs.appendFileSync(progressFilePath, JSON.stringify(crashEvent) + '\n');
      } catch { /* non-fatal */ }

      return {
        success: false,
        project,
        message: `Playwright process crashed during startup (exit code: ${result.code}, signal: ${result.signal})${stdout ? `\nstdout: ${stdout.slice(0, 2000)}` : ''}${snippet ? `\nstderr: ${snippet}` : ''}`,
      };
    }

    if (result.type === 'stall') {
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      const snippet = stderr.length > 2000 ? stderr.slice(0, 2000) + '...' : stderr;
      const lastContext = lastOutputLine ? `\nLast output: ${lastOutputLine}` : '';
      return {
        success: false,
        project,
        message: `Playwright process stalled (no output for ${Math.round(STALL_MS / 1000)}s after startup grace period)${lastContext}${snippet ? `\nstderr: ${snippet}` : ''}`,
      };
    }

    // Still running (or auto-killed after suite_end) — detach and return success
    if (child.stdout) {
      child.stdout.removeAllListeners('data');
      child.stdout.resume();
    }
    if (child.stderr) {
      child.stderr.removeAllListeners('data');
      child.stderr.resume();
    }

    // Register demo run for check_demo_result tracking
    const demoPid = child.pid!;
    const isSuiteEndKilled = result.type === 'suite_end_killed';
    const demoState: DemoRunState = {
      pid: demoPid,
      project,
      test_file,
      started_at: new Date().toISOString(),
      // suite_end_killed: process was already sent SIGTERM — mark 'passed' directly
      // to avoid a race where the exit handler never fires (process already dead)
      status: isSuiteEndKilled ? 'passed' : 'running',
      progress_file: progressFilePath,
    };
    if (isSuiteEndKilled) {
      demoState.ended_at = new Date().toISOString();
      demoState.stdout_tail = stdoutLines.join('\n').slice(0, 5000);
      suiteEndAutoKilledPids.add(demoPid);
    }
    demoRuns.set(demoPid, demoState);
    persistDemoRuns();

    // Track exit for post-hoc status checks (fires even after unref since MCP server stays alive)
    child.on('exit', (code) => {
      clearAutoKillTimer(demoPid);
      const entry = demoRuns.get(demoPid);
      if (!entry) return;

      // If suite_end_killed already finalized or autoKillDemo already finalized, don't overwrite
      if (entry.status !== 'running') return;

      entry.ended_at = new Date().toISOString();
      entry.exit_code = code ?? undefined;
      entry.status = (code === 0) ? 'passed' : 'failed';
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

      // Clean up progress file (best-effort)
      if (entry.progress_file) {
        try { fs.unlinkSync(entry.progress_file); } catch { /* Non-fatal */ }
      }

      persistDemoRuns();
    });

    child.unref();

    // Start auto-kill countdown — reset on each check_demo_result poll
    resetAutoKillTimer(demoPid);

    const warningText = preflight.warnings.length > 0
      ? `\nWarnings:\n${preflight.warnings.map(w => `  - ${w}`).join('\n')}`
      : '';

    const launchMessage = result.type === 'suite_end_killed'
      ? `Demo completed and process auto-killed after suite_end for project "${project}".${test_file ? ` File: ${test_file}.` : ''} Use check_demo_result to see the final status.${warningText}`
      : `Headed auto-play demo launched for project "${project}" with ${slow_mo}ms slow motion.${test_file ? ` Running file: ${test_file}.` : ''} The browser window should open shortly.${warningText}`;

    return {
      success: true,
      project,
      message: launchMessage,
      pid: child.pid,
      slow_mo,
      test_file,
      pause_at_end,
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
      message: `No demo run found for PID ${pid}. The process may have been launched before the MCP server started, or the PID is incorrect.`,
    };
  }

  // For 'running' entries, verify process is still alive
  if (entry.status === 'running') {
    try {
      process.kill(pid, 0); // Signal 0 = check if process exists
      // Process alive — reset auto-kill countdown
      resetAutoKillTimer(pid);
    } catch {
      // Process no longer exists but we didn't get the exit event (e.g., MCP restarted)
      clearAutoKillTimer(pid);
      entry.status = 'unknown';
      entry.ended_at = new Date().toISOString();
      persistDemoRuns();
      return {
        status: 'unknown',
        pid,
        project: entry.project,
        test_file: entry.test_file,
        started_at: entry.started_at,
        ended_at: entry.ended_at,
        message: `Demo process (PID ${pid}) is no longer running but exit status was not captured. Check test-results/ for output.`,
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

  return {
    status: entry.status,
    pid,
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
    message: statusMessages[entry.status] || `Demo status: ${entry.status}`,
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

  // Guard: only stop running demos
  if (entry.status !== 'running') {
    return {
      success: false,
      pid,
      project: entry.project,
      message: `Demo is not running (status: ${entry.status}).`,
    };
  }

  // Verify process is still alive before killing (prevents PID recycling issues)
  try {
    process.kill(pid, 0);
  } catch {
    entry.status = 'unknown';
    entry.ended_at = new Date().toISOString();
    persistDemoRuns();
    return {
      success: false,
      pid,
      project: entry.project,
      message: `Demo process (PID ${pid}) is no longer running.`,
    };
  }

  // Cancel auto-kill — manual stop takes over
  clearAutoKillTimer(pid);

  // Read final progress snapshot before killing
  const progress = entry.progress_file ? readDemoProgress(entry.progress_file) : null;

  // Kill the process group
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // Process may have already exited between check and kill
  }

  // Update demo run state
  entry.status = 'failed';
  entry.ended_at = new Date().toISOString();
  entry.failure_summary = 'Manually stopped';

  // Clean up progress file
  if (entry.progress_file) {
    try { fs.unlinkSync(entry.progress_file); } catch { /* Non-fatal */ }
  }

  persistDemoRuns();

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

  // Clean up zombie dev servers from previous runs
  cleanupDevServerPort();
  cleanupDevServerPort(3001);

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
      cwd: PROJECT_DIR,
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

  // Clean up zombie dev servers from previous runs
  cleanupDevServerPort();
  cleanupDevServerPort(3001);

  try {
    const output = execFileSync('npx', ['playwright', 'test', '--project=seed'], {
      cwd: PROJECT_DIR,
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

  // Clean up zombie dev servers from previous runs
  cleanupDevServerPort();
  cleanupDevServerPort(3001);

  try {
    const output = execFileSync('npx', ['playwright', 'test', '--project=seed'], {
      cwd: PROJECT_DIR,
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
        cwd: PROJECT_DIR,
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
 * Scan test-results/ and playwright-report/ for artifact files.
 * Returns paths to screenshots, videos, traces, and error context files.
 */
function scanArtifacts(maxEntries = 20): string[] {
  const artifacts: string[] = [];
  const dirs = [
    path.join(PROJECT_DIR, 'test-results'),
    path.join(PROJECT_DIR, 'playwright-report'),
  ];
  const extensions = new Set(['.png', '.webm', '.zip']);

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
 * Attempt to auto-start the dev server via `pnpm run dev`.
 * Returns a descriptive message on success, null on failure.
 */
async function attemptDevServerAutoStart(baseUrl: string): Promise<string | null> {
  const url = new URL(baseUrl);
  const port = url.port || '3000';
  const isHttps = url.protocol === 'https:';
  const httpModule = isHttps ? https : http;

  // Build env with secrets if available (non-fatal)
  let childEnv: Record<string, string>;
  try {
    const config = loadServicesConfig(PROJECT_DIR);
    const { resolvedEnv } = resolveLocalSecrets(config);
    childEnv = buildCleanEnv(resolvedEnv);
  } catch {
    childEnv = buildCleanEnv();
  }
  childEnv.PORT = port;

  // Spawn detached dev server, track PID for cleanup
  let childPid: number;
  try {
    const child = spawn('pnpm', ['run', 'dev'], {
      detached: true,
      stdio: 'ignore',
      cwd: PROJECT_DIR,
      env: childEnv,
    });
    child.unref();
    if (!child.pid) return null;
    childPid = child.pid;
  } catch {
    return null;
  }

  // Poll health every 2s for max 30s
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const ok = await new Promise<boolean>((resolve) => {
        const req = httpModule.request(
          { hostname: url.hostname, port: url.port || (isHttps ? 443 : 80), path: '/', method: 'GET', timeout: 3000 },
          (res) => {
            res.resume(); // drain
            resolve((res.statusCode ?? 0) < 500);
          }
        );
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end();
      });
      if (ok) return `Dev server auto-started on port ${port} (pid ${childPid})`;
    } catch {
      // continue polling
    }
  }

  // Health polling exhausted — kill the orphaned process
  try { process.kill(childPid, 'SIGTERM'); } catch { /* already dead */ }
  return null;
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
 * Comprehensive pre-flight validation before launching Playwright.
 * Checks config, deps, browsers, test files, credentials, compilation, and dev server.
 */
async function preflightCheck(args: PreflightCheckArgs): Promise<PreflightCheckResult> {
  const startTime = Date.now();
  const checks: PreflightCheckEntry[] = [];
  const failures: string[] = [];
  const warnings: string[] = [];
  const recoverySteps: string[] = [];

  // 1. Config exists
  checks.push(runCheck('config_exists', () => {
    const tsConfig = path.join(PROJECT_DIR, 'playwright.config.ts');
    const jsConfig = path.join(PROJECT_DIR, 'playwright.config.js');
    if (fs.existsSync(tsConfig)) {
      return { status: 'pass', message: `Found playwright.config.ts` };
    }
    if (fs.existsSync(jsConfig)) {
      return { status: 'pass', message: `Found playwright.config.js` };
    }
    return { status: 'fail', message: 'No playwright.config.ts or playwright.config.js found' };
  }));

  // 2. Dependencies installed
  checks.push(runCheck('dependencies_installed', () => {
    const pwTestDir = path.join(PROJECT_DIR, 'node_modules', '@playwright', 'test');
    if (fs.existsSync(pwTestDir)) {
      return { status: 'pass', message: '@playwright/test is installed' };
    }
    return { status: 'fail', message: '@playwright/test not found in node_modules' };
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

      const fullDir = path.join(PROJECT_DIR, testDir);
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

  // 6. Compilation succeeds (unless skipped)
  if (!args.skip_compilation && args.project) {
    checks.push(runCheck('compilation', () => {
      try {
        const listArgs = ['playwright', 'test', '--list', '--project', args.project!];
        const output = execFileSync('npx', listArgs, {
          cwd: PROJECT_DIR,
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
  const baseUrl = args.base_url || 'http://localhost:3000';
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

  // 8. Auth state freshness (only when a project is specified)
  if (args.project) {
    checks.push(runCheck('auth_state', () => {
      const authDir = path.join(PROJECT_DIR, '.auth');

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
      case 'compilation':
        recoverySteps.push('Fix TypeScript compilation errors — run: npx playwright test --list to see details');
        break;
      case 'auth_state':
        recoverySteps.push('Run: mcp__playwright__run_auth_setup() to refresh auth cookies');
        break;
      case 'dev_server':
        recoverySteps.push('Start the dev server (e.g., pnpm dev) or verify playwright.config.ts webServer configuration');
        break;
      case 'extension_manifest':
        recoverySteps.push('Fix invalid match patterns in manifest.json — Chrome requires host to be * | *.domain.com | exact.domain.com (no partial wildcards like *-admin.example.com)');
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

  const phases: RunAuthSetupResult['phases'] = [];

  // Phase 1: Seed
  const seedStart = Date.now();
  try {
    execFileSync('npx', ['playwright', 'test', '--project=seed'], {
      cwd: PROJECT_DIR,
      timeout: 60_000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env as Record<string, string>,
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
      cwd: PROJECT_DIR,
      timeout: 240_000, // 4 min: web server startup + 4 persona sign-ins
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env as Record<string, string>,
    });
    phases.push({ name: 'auth-setup', success: true, message: 'Auth setup completed', duration_ms: Date.now() - authStart });

    const authDir = path.join(PROJECT_DIR, '.auth');
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
      'Best for presentations and demos. Supports headless mode (headless: true) for CI or screenshot capture, ' +
      'and show_cursor for a visible cursor dot. The target project\'s playwright.config.ts must read ' +
      'parseInt(process.env.DEMO_SLOW_MO || "0") in use.launchOptions.slowMo for pace control to work.',
    schema: RunDemoArgsSchema,
    handler: runDemo,
  },
  {
    name: 'check_demo_result',
    description:
      'Check the result of a previously launched demo run by PID. ' +
      'Call after run_demo to determine if the demo passed or failed. ' +
      'Returns status (running/passed/failed/unknown), exit code, failure summary, screenshot paths, ' +
      'and a progress object with real-time test counts, current test name, and error detection. ' +
      'Auto-kill: demo processes are automatically killed if this tool is not called within 60 seconds. ' +
      'Each poll resets the countdown. Prevents orphaned browser processes when the polling agent stops.',
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
];

const server = new McpServer({
  name: 'playwright',
  version: '1.0.0',
  tools,
});

server.start();
