#!/usr/bin/env node
/**
 * Quota Recovery Daemon — Sub-10-second resume when Anthropic quota resets.
 *
 * Watches .claude/state/quota-exhaustion.json for quota exhaustion events.
 * When exhaustion is detected, schedules a precise timer based on resets_at
 * and polls the usage API every 5 seconds near the reset time.
 *
 * When quota is available again, clears the exhaustion state and triggers
 * drainQueue() to resume all sessions.
 *
 * Runs as a launchd KeepAlive service alongside revival-daemon and hourly-automation.
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
try { process.chdir(PROJECT_DIR); } catch { /* non-fatal */ }

const STATE_DIR = path.join(PROJECT_DIR, '.claude', 'state');
const QUOTA_STATE_PATH = path.join(STATE_DIR, 'quota-exhaustion.json');
const LOG_FILE = path.join(PROJECT_DIR, '.claude', 'quota-recovery-daemon.log');
const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');

const USAGE_API_URL = 'https://api.anthropic.com/api/oauth/usage';
const ANTHROPIC_BETA = 'oauth-2025-04-20';

const POLL_INTERVAL_MS = 5000;       // 5 seconds during active recovery polling
const IDLE_POLL_INTERVAL_MS = 30000; // 30 seconds when idle (fs.watch fallback)
const PRE_RESET_WINDOW_MS = 15000;   // Start polling 15s before reset time
const POST_RESET_GRACE_MS = 120000;  // Continue polling 120s after reset if API hasn't cleared
const EXHAUSTION_THRESHOLD = 99;     // Utilization percentage threshold

let recoveryTimer = null;
let pollInterval = null;
let idleInterval = null;
let watcher = null;

// ============================================================================
// Logging
// ============================================================================

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    process.stderr.write(line);
  }
}

// ============================================================================
// State Management
// ============================================================================

function readQuotaState() {
  try {
    if (!fs.existsSync(QUOTA_STATE_PATH)) return null;
    return JSON.parse(fs.readFileSync(QUOTA_STATE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function clearQuotaState() {
  try {
    const data = {
      exhausted: false,
      exhausted_at: null,
      resets_at: null,
      window: null,
      utilization: null,
      sessions_killed: 0,
      cleared_at: new Date().toISOString(),
    };
    fs.writeFileSync(QUOTA_STATE_PATH, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    log(`Failed to clear quota state: ${err.message}`);
    return false;
  }
}

// ============================================================================
// OAuth Token Resolution
// ============================================================================

function getOAuthToken() {
  const envToken = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
  if (envToken) return envToken;

  if (process.platform === 'darwin') {
    try {
      const { username } = os.userInfo();
      const raw = execFileSync('security', [
        'find-generic-password', '-s', 'Claude Code-credentials', '-a', username, '-w',
      ], { encoding: 'utf8', timeout: 3000 }).trim();
      const creds = JSON.parse(raw);
      const token = creds.claudeAiOauth?.accessToken;
      if (token) {
        if (creds.claudeAiOauth.expiresAt && creds.claudeAiOauth.expiresAt < Date.now()) return null;
        return token;
      }
    } catch { /* fall through */ }
  }

  try {
    if (fs.existsSync(CREDENTIALS_PATH)) {
      const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
      return creds.claudeAiOauth?.accessToken || null;
    }
  } catch { /* fall through */ }

  return null;
}

// ============================================================================
// Usage API Check
// ============================================================================

async function checkQuotaRecovered() {
  const token = getOAuthToken();
  if (!token) {
    log('No OAuth token — cannot check quota');
    return false;
  }

  try {
    const response = await fetch(USAGE_API_URL, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'claude-code/2.1.14',
        'anthropic-beta': ANTHROPIC_BETA,
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      log(`API returned ${response.status}`);
      return false;
    }

    const data = await response.json();
    const fiveHourOk = !data.five_hour || data.five_hour.utilization < EXHAUSTION_THRESHOLD;
    const sevenDayOk = !data.seven_day || data.seven_day.utilization < EXHAUSTION_THRESHOLD;

    if (fiveHourOk && sevenDayOk) {
      return true; // quota recovered
    }

    log(`Still exhausted: 5h=${data.five_hour?.utilization?.toFixed(1)}%, 7d=${data.seven_day?.utilization?.toFixed(1)}%`);
    return false;
  } catch (err) {
    log(`API check failed: ${err.message}`);
    return false;
  }
}

// ============================================================================
// Recovery Actions
// ============================================================================

// Auto-resolve synthesized quota_exhaustion bypass requests on recovery.
// quota-detector files these rows when it sees "You've hit your limit" in a
// dead session JSONL. They are not agent-authored and need no CTO decision —
// they exist so the linked task is paused until quota recovers. On recovery,
// resolve them all so the CTO inbox is not polluted with stale slips.
//
// When `accountHint` is provided, we resolve only rows tagged with that
// account; rows with NULL synthesis_account (legacy or unresolvable
// credentials) are always resolved on any recovery.
function resolveSynthesizedBypasses(accountHint) {
  const dbPath = path.join(PROJECT_DIR, '.claude', 'state', 'bypass-requests.db');
  if (!fs.existsSync(dbPath)) return 0;
  let Database;
  try {
    Database = createRequire(import.meta.url)('better-sqlite3');
  } catch {
    return 0;
  }
  let db;
  try {
    db = new Database(dbPath);
    db.pragma('busy_timeout = 3000');
    const cols = db.prepare("PRAGMA table_info(bypass_requests)").all();
    if (!cols.some(c => c.name === 'synthesized')) return 0;
    let result;
    if (accountHint) {
      result = db.prepare(`
        UPDATE bypass_requests
           SET status = 'approved',
               resolution_context = 'Auto-resolved by quota-recovery-daemon (quota recovered for ' || ? || ')',
               resolved_at = datetime('now'),
               resolved_by = 'quota-recovery-daemon'
         WHERE synthesized = 1
           AND auto_resolvable = 1
           AND status = 'pending'
           AND (synthesis_account IS NULL OR synthesis_account = ?)
      `).run(accountHint, accountHint);
    } else {
      result = db.prepare(`
        UPDATE bypass_requests
           SET status = 'approved',
               resolution_context = 'Auto-resolved by quota-recovery-daemon (quota recovered)',
               resolved_at = datetime('now'),
               resolved_by = 'quota-recovery-daemon'
         WHERE synthesized = 1
           AND auto_resolvable = 1
           AND status = 'pending'
      `).run();
    }
    return result.changes;
  } catch (err) {
    log(`Failed to auto-resolve synthesized bypasses: ${err.message}`);
    return 0;
  } finally {
    try { db && db.close(); } catch { /* best-effort */ }
  }
}

// Sweep synthesized rows older than the window TTL. Catches stale rows from
// detection events whose recovery the daemon missed (e.g. account credentials
// not resolvable at recovery time, or daemon offline). Default TTL 24h is
// roughly 2× the longest expected quota window. Runs idempotently on every
// daemon idle tick — safe to call repeatedly.
function sweepStaleSynthesizedBypasses(staleAgeHours = 24) {
  const dbPath = path.join(PROJECT_DIR, '.claude', 'state', 'bypass-requests.db');
  if (!fs.existsSync(dbPath)) return 0;
  let Database;
  try {
    Database = createRequire(import.meta.url)('better-sqlite3');
  } catch {
    return 0;
  }
  let db;
  try {
    db = new Database(dbPath);
    db.pragma('busy_timeout = 3000');
    const cols = db.prepare("PRAGMA table_info(bypass_requests)").all();
    if (!cols.some(c => c.name === 'synthesized')) return 0;
    const result = db.prepare(`
      UPDATE bypass_requests
         SET status = 'approved',
             resolution_context = 'Auto-resolved by quota-recovery-daemon (stale sweep — older than ' || ? || 'h)',
             resolved_at = datetime('now'),
             resolved_by = 'quota-recovery-daemon-sweep'
       WHERE synthesized = 1
         AND auto_resolvable = 1
         AND status = 'pending'
         AND datetime(created_at) < datetime('now', '-' || ? || ' hours')
    `).run(staleAgeHours, staleAgeHours);
    return result.changes;
  } catch (err) {
    log(`Stale-sweep failed: ${err.message}`);
    return 0;
  } finally {
    try { db && db.close(); } catch { /* best-effort */ }
  }
}

async function executeRecovery() {
  log('QUOTA RECOVERED — clearing exhaustion state and draining queue');
  const prevState = readQuotaState();
  const account = (prevState && prevState.account) || null;
  clearQuotaState();

  // Auto-resolve synthesized bypass requests so the CTO inbox does not retain
  // noise after the quota window cleared. We resolve scoped to the account
  // when we know which one recovered.
  const resolvedCount = resolveSynthesizedBypasses(account);
  if (resolvedCount > 0) {
    log(`Auto-resolved ${resolvedCount} synthesized quota bypass(es)${account ? ` for ${account}` : ''}`);
  }

  // Trigger drainQueue to resume sessions
  try {
    const { drainQueue } = await import(path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'session-queue.js'));
    drainQueue();
    log('drainQueue triggered — sessions will resume');
  } catch (err) {
    log(`drainQueue failed: ${err.message}`);
  }

  // Audit event
  try {
    const { auditEvent } = await import(path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'session-audit.js'));
    auditEvent('quota_exhaustion_cleared', {
      source: 'quota-recovery-daemon',
      synthesized_resolved: resolvedCount,
      account,
    });
  } catch { /* non-fatal */ }
}

// ============================================================================
// Active Polling (near reset time)
// ============================================================================

function stopActivePolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

function startActivePolling(resetTime) {
  stopActivePolling();
  log('Starting active quota polling (every 5 seconds)');

  pollInterval = setInterval(async () => {
    const state = readQuotaState();
    if (!state || !state.exhausted) {
      log('State cleared externally — stopping active polling');
      stopActivePolling();
      enterIdleMode();
      return;
    }

    const recovered = await checkQuotaRecovered();
    if (recovered) {
      stopActivePolling();
      await executeRecovery();
      enterIdleMode();
      return;
    }

    // Grace period: give up if well past reset time and still exhausted
    if (Date.now() > resetTime + POST_RESET_GRACE_MS) {
      log(`Post-reset grace period exceeded (${POST_RESET_GRACE_MS / 1000}s) — falling back to idle polling`);
      stopActivePolling();
      enterIdleMode();
    }
  }, POLL_INTERVAL_MS);
}

// ============================================================================
// Recovery Scheduling
// ============================================================================

function cancelRecoveryTimer() {
  if (recoveryTimer) {
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
  }
}

function scheduleRecovery(resetsAt) {
  cancelRecoveryTimer();
  const resetTime = new Date(resetsAt).getTime();
  const delay = resetTime - Date.now() - PRE_RESET_WINDOW_MS;

  if (delay <= 0) {
    // Already within the polling window or past reset time — start polling immediately
    log(`Reset time is imminent or past — starting active polling now`);
    startActivePolling(resetTime);
  } else {
    const delaySec = Math.round(delay / 1000);
    const delayMin = Math.round(delaySec / 60);
    log(`Scheduling active polling in ${delayMin > 1 ? delayMin + 'min' : delaySec + 's'} (reset at ${resetsAt})`);
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      startActivePolling(resetTime);
    }, delay);
  }
}

// ============================================================================
// Idle Mode (watching for state file changes)
// ============================================================================

function stopIdleMode() {
  if (idleInterval) {
    clearInterval(idleInterval);
    idleInterval = null;
  }
}

function checkStateAndAct() {
  const state = readQuotaState();
  if (state && state.exhausted && state.resets_at) {
    log(`Exhaustion detected: ${state.window} at ${state.utilization}%, resets at ${state.resets_at}`);
    stopIdleMode();
    scheduleRecovery(state.resets_at);
  }
}

function enterIdleMode() {
  cancelRecoveryTimer();
  stopActivePolling();
  stopIdleMode();

  // Poll every 30s as fs.watch fallback. Also runs the synthesized-bypass
  // stale sweep — this is cheap (UPDATE on a small indexed table) and catches
  // rows the executeRecovery() path missed (e.g. daemon was offline when the
  // quota window cleared, or credentials were unresolvable at recovery time).
  idleInterval = setInterval(() => {
    checkStateAndAct();
    const swept = sweepStaleSynthesizedBypasses();
    if (swept > 0) {
      log(`Stale-sweep auto-resolved ${swept} synthesized bypass row(s) >24h old`);
    }
  }, IDLE_POLL_INTERVAL_MS);
}

// ============================================================================
// Main
// ============================================================================

function main() {
  log('Quota recovery daemon starting');

  // Ensure state directory exists
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }

  // Watch for state file changes
  try {
    const watchDir = STATE_DIR;
    watcher = fs.watch(watchDir, (eventType, filename) => {
      if (filename === 'quota-exhaustion.json') {
        checkStateAndAct();
      }
    });
    watcher.on('error', () => {
      log('fs.watch error — relying on poll fallback');
    });
  } catch (err) {
    log(`fs.watch setup failed: ${err.message} — relying on poll fallback`);
  }

  // Initial state check
  const state = readQuotaState();
  if (state && state.exhausted && state.resets_at) {
    log(`Starting in recovery-watch mode: ${state.window} at ${state.utilization}%, resets at ${state.resets_at}`);
    scheduleRecovery(state.resets_at);
  } else {
    log('Starting in idle mode (no active exhaustion)');
    enterIdleMode();
  }

  // Keep process alive
  process.on('SIGTERM', () => {
    log('Received SIGTERM — shutting down');
    cancelRecoveryTimer();
    stopActivePolling();
    stopIdleMode();
    if (watcher) watcher.close();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    log('Received SIGINT — shutting down');
    cancelRecoveryTimer();
    stopActivePolling();
    stopIdleMode();
    if (watcher) watcher.close();
    process.exit(0);
  });
}

main();
