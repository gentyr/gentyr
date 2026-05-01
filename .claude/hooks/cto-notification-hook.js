#!/usr/bin/env node
/**
 * CTO Notification Hook
 *
 * Runs on UserPromptSubmit to notify the user of pending CTO items and session metrics.
 * Checks deputy-cto and agent-reports databases, token usage, and session counts.
 *
 * Usage: Called by Claude Code UserPromptSubmit hook
 *
 * @version 2.0.0
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { findMostRecentSession, getSessionContextTokens as getSharedContextTokens } from './lib/compact-session.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Try to import better-sqlite3
let Database = null;
try {
  Database = (await import('better-sqlite3')).default;
} catch (err) {
  console.error('[cto-notification-hook] Warning:', err.message);
  // Database not available
}

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

/**
 * Get current git branch and worktree name by reading .git directly (no subprocess).
 * Returns { branch, worktreeName } or null if not in a git repo.
 */
function getGitContext() {
  const gitPath = path.join(PROJECT_DIR, '.git');
  try {
    const stat = fs.lstatSync(gitPath);
    let headPath;
    let worktreeName = null;

    if (stat.isFile()) {
      // Worktree: .git is a file containing "gitdir: <path>"
      const gitFile = fs.readFileSync(gitPath, 'utf8').trim();
      const match = gitFile.match(/^gitdir:\s*(.+)$/);
      if (!match) return null;
      const gitDir = path.isAbsolute(match[1]) ? match[1] : path.resolve(PROJECT_DIR, match[1]);
      headPath = path.join(gitDir, 'HEAD');
      // Extract worktree name from .../.git/worktrees/<name>
      const wtMatch = gitDir.match(/\.git\/worktrees\/(.+)$/);
      worktreeName = wtMatch ? wtMatch[1] : path.basename(PROJECT_DIR);
    } else {
      // Main tree
      headPath = path.join(gitPath, 'HEAD');
    }

    const head = fs.readFileSync(headPath, 'utf8').trim();
    const branchMatch = head.match(/^ref: refs\/heads\/(.+)$/);
    const branch = branchMatch ? branchMatch[1] : head.substring(0, 8); // detached HEAD

    return { branch, worktreeName };
  } catch (err) {
    console.error('[cto-notification-hook] Warning:', err.message);
    return null;
  }
}
const DEPUTY_CTO_DB = path.join(PROJECT_DIR, '.claude', 'deputy-cto.db');
const CTO_REPORTS_DB = path.join(PROJECT_DIR, '.claude', 'cto-reports.db');
const TODO_DB = path.join(PROJECT_DIR, '.claude', 'todo.db');
const PLANS_DB = path.join(PROJECT_DIR, '.claude', 'state', 'plans.db');
const RELEASE_LEDGER_DB = path.join(PROJECT_DIR, '.claude', 'state', 'release-ledger.db');
const AGENT_TRACKER_HISTORY = path.join(PROJECT_DIR, '.claude', 'state', 'agent-tracker-history.json');
const AUTONOMOUS_CONFIG_PATH = path.join(PROJECT_DIR, '.claude', 'autonomous-mode.json');
const AUTOMATION_STATE_PATH = path.join(PROJECT_DIR, '.claude', 'hourly-automation-state.json');
const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const ANTHROPIC_API_URL = 'https://api.anthropic.com/api/oauth/usage';
const ANTHROPIC_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const ANTHROPIC_BETA_HEADER = 'oauth-2025-04-20';
const COOLDOWN_MINUTES = 55;
// Cache goes in ~/.claude/ (user-owned) since project .claude/ may be root-protected
const METRICS_CACHE_PATH = path.join(os.homedir(), '.claude', `cto-metrics-cache-${PROJECT_DIR.replace(/[^a-zA-Z0-9]/g, '-').replace(/^-/, '')}.json`);

/**
 * Get session directory path for this project
 */
function getSessionDir() {
  const projectPath = PROJECT_DIR.replace(/[^a-zA-Z0-9]/g, '-').replace(/^-/, '');
  return path.join(os.homedir(), '.claude', 'projects', `-${projectPath}`);
}

/**
 * Get pending counts from deputy-cto database
 * G001: Returns null on error to allow caller to handle appropriately
 */
function getDeputyCtoCounts() {
  if (!Database) {
    // Database module not available - this is expected in some environments
    return { pending: 0, rejections: 0, error: false };
  }

  if (!fs.existsSync(DEPUTY_CTO_DB)) {
    // No database yet - first run, no pending items
    return { pending: 0, rejections: 0, error: false };
  }

  try {
    const db = new Database(DEPUTY_CTO_DB, { readonly: true });

    const pending = db.prepare(
      "SELECT COUNT(*) as count FROM questions WHERE status = 'pending'"
    ).get();

    const rejections = db.prepare(
      "SELECT COUNT(*) as count FROM questions WHERE type = 'rejection' AND status = 'pending'"
    ).get();

    db.close();

    return {
      pending: pending?.count || 0,
      rejections: rejections?.count || 0,
      error: false,
    };
  } catch (err) {
    // G001: Log error and signal failure
    console.error(`[cto-notification] Database error: ${err.message}`);
    return { pending: 0, rejections: 0, error: true };
  }
}

/**
 * Get unread count from agent-reports database
 */
function getUnreadReportsCount() {
  if (!Database || !fs.existsSync(CTO_REPORTS_DB)) {
    return 0;
  }

  try {
    const db = new Database(CTO_REPORTS_DB, { readonly: true });

    const result = db.prepare(
      "SELECT COUNT(*) as count FROM reports WHERE read_at IS NULL"
    ).get();

    db.close();

    return result?.count || 0;
  } catch (_) { /* cleanup - failure expected */
    return 0;
  }
}

/**
 * Get autonomous mode status
 */
function getAutonomousModeStatus() {
  // Get config
  let enabled = false;
  if (fs.existsSync(AUTONOMOUS_CONFIG_PATH)) {
    try {
      const config = JSON.parse(fs.readFileSync(AUTONOMOUS_CONFIG_PATH, 'utf8'));
      enabled = config.enabled === true;
    } catch (err) {
      console.error(`[cto-notification] Config parse error (autonomous mode disabled): ${err.message}`);
    }
  }

  // Get next run time
  let nextRunMinutes = null;
  if (enabled && fs.existsSync(AUTOMATION_STATE_PATH)) {
    try {
      const state = JSON.parse(fs.readFileSync(AUTOMATION_STATE_PATH, 'utf8'));
      const lastRun = state.lastRun || 0;
      const now = Date.now();
      const timeSinceLastRun = now - lastRun;
      const cooldownMs = COOLDOWN_MINUTES * 60 * 1000;

      if (timeSinceLastRun >= cooldownMs) {
        nextRunMinutes = 0;
      } else {
        nextRunMinutes = Math.ceil((cooldownMs - timeSinceLastRun) / 60000);
      }
    } catch (err) {
      console.error(`[cto-notification] State file parse error: ${err.message}`);
      nextRunMinutes = null;
    }
  } else if (enabled) {
    nextRunMinutes = 0; // First run
  }

  return { enabled, nextRunMinutes };
}

/**
 * Load metrics cache from disk
 */
function loadMetricsCache() {
  try {
    if (fs.existsSync(METRICS_CACHE_PATH)) {
      return JSON.parse(fs.readFileSync(METRICS_CACHE_PATH, 'utf8'));
    }
  } catch (err) {
    console.error('[cto-notification-hook] Warning:', err.message);
  }
  return { files: {}, totals: { tokens: 0, taskSessions: 0, userSessions: 0 } };
}

/**
 * Save metrics cache to disk
 */
function saveMetricsCache(cache) {
  try {
    fs.writeFileSync(METRICS_CACHE_PATH, JSON.stringify(cache), 'utf8');
  } catch (err) {
    console.error('[cto-notification-hook] Warning:', err.message);
  }
}

/**
 * Scan a single session file for tokens and session type.
 * For session type, only reads the first 4KB to find the first user message.
 */
function scanSessionFile(filePath, since) {
  let tokens = 0;
  let isTask = false;

  try {
    // Read first 4KB for session type detection
    const fd = fs.openSync(filePath, 'r');
    const headerBuf = Buffer.alloc(4096);
    const bytesRead = fs.readSync(fd, headerBuf, 0, 4096, 0);
    fs.closeSync(fd);

    const headerText = headerBuf.toString('utf8', 0, bytesRead);
    const headerLines = headerText.split('\n');
    for (const line of headerLines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'human' || entry.type === 'user') {
          const msg = typeof entry.message?.content === 'string'
            ? entry.message.content
            : entry.content;
          if (msg && (msg.startsWith('[Automation]') || msg.startsWith('[Task]'))) {
            isTask = true;
          }
          break;
        }
      } catch (err) {
        console.error('[cto-notification-hook] Warning:', err.message);
      }
    }

    // Full scan for token usage
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.timestamp) {
          const entryTime = new Date(entry.timestamp).getTime();
          if (entryTime < since) continue;
        }
        const usage = entry.message?.usage;
        if (usage) {
          tokens += usage.input_tokens || 0;
          tokens += usage.output_tokens || 0;
          tokens += usage.cache_read_input_tokens || 0;
          tokens += usage.cache_creation_input_tokens || 0;
        }
      } catch (err) {
        console.error('[cto-notification-hook] Warning:', err.message);
      }
    }
  } catch (err) {
    console.error('[cto-notification-hook] Warning:', err.message);
  }

  return { tokens, isTask };
}

/**
 * Get token usage and session metrics for last 30 days using incremental cache.
 * Only re-scans files that are new or have changed since last cache update.
 * Uses a time budget (3s) to avoid blocking — builds cache across multiple prompts.
 */
function getSessionMetricsCached() {
  const sessionDir = getSessionDir();
  const since = Date.now() - (30 * 24 * 60 * 60 * 1000);
  const TIME_BUDGET_MS = 3000;

  if (!fs.existsSync(sessionDir)) {
    return { tokens: 0, taskSessions: 0, userSessions: 0 };
  }

  const cache = loadMetricsCache();
  let changed = false;
  const startTime = Date.now();

  try {
    const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'));

    // Remove cache entries for files that no longer exist or are outside 30d window
    for (const key of Object.keys(cache.files)) {
      if (!files.includes(key)) {
        delete cache.files[key];
        changed = true;
      }
    }

    // Sort files: prioritize current session (most recently modified) first
    const fileMetas = [];
    for (const file of files) {
      try {
        const stat = fs.statSync(path.join(sessionDir, file));
        fileMetas.push({ file, mtime: stat.mtime.getTime(), size: stat.size });
      } catch (err) {
        console.error('[cto-notification-hook] Warning:', err.message);
      }
    }
    fileMetas.sort((a, b) => b.mtime - a.mtime);

    // Scan new or modified files within time budget
    for (const { file, mtime, size } of fileMetas) {
      // Check time budget
      if (Date.now() - startTime > TIME_BUDGET_MS) {
        break;
      }

      const filePath = path.join(sessionDir, file);

      // Skip files outside 30-day window
      if (mtime < since) {
        if (cache.files[file]) {
          delete cache.files[file];
          changed = true;
        }
        continue;
      }

      const cached = cache.files[file];

      // Skip if file hasn't changed
      if (cached && cached.size === size && cached.mtime === mtime) {
        continue;
      }

      // Re-scan this file
      const result = scanSessionFile(filePath, since);
      cache.files[file] = {
        size,
        mtime,
        tokens: result.tokens,
        isTask: result.isTask,
      };
      changed = true;
    }
  } catch (err) {
    console.error('[cto-notification-hook] Warning:', err.message);
  }

  // Recompute totals from cache
  let tokens = 0, taskSessions = 0, userSessions = 0;
  for (const entry of Object.values(cache.files)) {
    tokens += entry.tokens || 0;
    if (entry.isTask) {
      taskSessions++;
    } else {
      userSessions++;
    }
  }

  cache.totals = { tokens, taskSessions, userSessions };

  if (changed) {
    saveMetricsCache(cache);
  }

  return cache.totals;
}

/**
 * Get plan summary for active plans
 * Returns compact string or null if no active plans
 */
function getPlanSummary() {
  if (!Database || !fs.existsSync(PLANS_DB)) {
    return null;
  }

  try {
    const db = new Database(PLANS_DB, { readonly: true });

    const activePlans = db.prepare(
      "SELECT COUNT(*) as count FROM plans WHERE status = 'active'"
    ).get();

    if (activePlans.count === 0) {
      db.close();
      return null;
    }

    // Get progress per active plan
    const plans = db.prepare(
      "SELECT id FROM plans WHERE status = 'active'"
    ).all();

    let totalPct = 0;
    let readyCount = 0;
    let activeAgents = 0;

    for (const plan of plans) {
      const taskTotal = db.prepare(
        "SELECT COUNT(*) as count FROM plan_tasks WHERE plan_id = ?"
      ).get(plan.id);
      const taskComplete = db.prepare(
        "SELECT COUNT(*) as count FROM plan_tasks WHERE plan_id = ? AND status IN ('completed', 'skipped')"
      ).get(plan.id);
      const ready = db.prepare(
        "SELECT COUNT(*) as count FROM plan_tasks WHERE plan_id = ? AND status = 'ready'"
      ).get(plan.id);
      const active = db.prepare(
        "SELECT COUNT(*) as count FROM plan_tasks WHERE plan_id = ? AND status = 'in_progress'"
      ).get(plan.id);

      totalPct += taskTotal.count > 0 ? Math.round((taskComplete.count / taskTotal.count) * 100) : 0;
      readyCount += ready.count;
      activeAgents += active.count;
    }

    db.close();

    return `PLANS: ${activePlans.count} active | ${Math.round(totalPct / plans.length)}% overall | ${readyCount} ready to spawn | ${activeAgents} agents running`;
  } catch (_) { /* cleanup - failure expected */
    return null;
  }
}

/**
 * Get TODO counts by status
 * Returns both queued (pending) and active (in_progress) counts
 */
function getTodoCounts() {
  if (!Database || !fs.existsSync(TODO_DB)) {
    return { queued: 0, active: 0 };
  }

  try {
    const db = new Database(TODO_DB, { readonly: true });
    const queued = db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'pending'").get();
    const active = db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'in_progress'").get();
    db.close();
    return {
      queued: queued?.count || 0,
      active: active?.count || 0,
    };
  } catch (_) { /* cleanup - failure expected */
    return { queued: 0, active: 0 };
  }
}

/**
 * Get count of active blocking queue items
 */
function getBlockingQueueCount() {
  try {
    const dbPath = path.join(PROJECT_DIR, '.claude', 'state', 'bypass-requests.db');
    if (!fs.existsSync(dbPath)) return 0;
    if (!Database) return 0;
    const db = new Database(dbPath, { readonly: true });
    db.pragma('busy_timeout = 1000');
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='blocking_queue'").get();
    if (!tableExists) { db.close(); return 0; }
    const result = db.prepare("SELECT COUNT(*) as cnt FROM blocking_queue WHERE status = 'active'").get();
    db.close();
    return result?.cnt || 0;
  } catch (_) {
    return 0;
  }
}

/**
 * Cache for pending bypass requests (60-second TTL)
 */
let _bypassRequestsCache = null;
let _bypassRequestsCacheTime = 0;
const BYPASS_REQUESTS_CACHE_TTL_MS = 60000;

/**
 * Get pending bypass requests with full details for CTO action.
 * Uses a 60-second cache to avoid querying the DB on every prompt.
 * Returns array of { id, task_title, category, summary, created_at } or empty array.
 */
function getPendingBypassRequests() {
  const now = Date.now();
  if (_bypassRequestsCache !== null && (now - _bypassRequestsCacheTime) < BYPASS_REQUESTS_CACHE_TTL_MS) {
    return _bypassRequestsCache;
  }

  try {
    const dbPath = path.join(PROJECT_DIR, '.claude', 'state', 'bypass-requests.db');
    if (!fs.existsSync(dbPath) || !Database) {
      _bypassRequestsCache = [];
      _bypassRequestsCacheTime = now;
      return _bypassRequestsCache;
    }
    const db = new Database(dbPath, { readonly: true });
    db.pragma('busy_timeout = 1000');
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='bypass_requests'").get();
    if (!tableExists) {
      db.close();
      _bypassRequestsCache = [];
      _bypassRequestsCacheTime = now;
      return _bypassRequestsCache;
    }
    const rows = db.prepare(
      "SELECT id, task_title, category, summary, created_at FROM bypass_requests WHERE status = 'pending' ORDER BY created_at ASC"
    ).all();
    db.close();
    _bypassRequestsCache = rows || [];
    _bypassRequestsCacheTime = now;
    return _bypassRequestsCache;
  } catch (_) {
    _bypassRequestsCache = [];
    _bypassRequestsCacheTime = now;
    return _bypassRequestsCache;
  }
}

/**
 * Read preview → staging drift count from automation state file.
 * Fast: file read only, no git subprocess.
 */
function getPreviewDriftFromState() {
  try {
    const statePath = path.join(PROJECT_DIR, '.claude', 'state', 'hourly-automation-state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return state.previewStagingDriftCount || 0;
  } catch { return 0; }
}

/**
 * Get active release status for the CTO status line.
 * Returns null if no active release, or { label } with the display string.
 */
function getReleaseStatus() {
  if (!Database || !fs.existsSync(RELEASE_LEDGER_DB)) return null;
  try {
    const db = new Database(RELEASE_LEDGER_DB, { readonly: true });
    db.pragma('busy_timeout = 3000');
    const release = db.prepare(
      "SELECT id, plan_id FROM releases WHERE status = 'in_progress' LIMIT 1"
    ).get();
    if (!release) { db.close(); return null; }

    // Check if the release plan has reached Phase 7 (CTO Sign-off)
    let awaitingSignOff = false;
    if (release.plan_id && fs.existsSync(PLANS_DB)) {
      try {
        const planDb = new Database(PLANS_DB, { readonly: true });
        planDb.pragma('busy_timeout = 3000');
        const completedPhases = planDb.prepare(
          "SELECT COUNT(*) as count FROM phases WHERE plan_id = ? AND status IN ('completed', 'skipped')"
        ).get(release.plan_id);
        planDb.close();
        if ((completedPhases?.count || 0) >= 6) {
          awaitingSignOff = true;
        }
      } catch (_) {
        // Non-fatal
      }
    }

    db.close();
    if (awaitingSignOff) {
      return {
        label: `RELEASE SIGN-OFF — present_release_summary({ release_id: "${release.id}" }) to review`,
      };
    }
    return { label: 'RELEASE IN PROGRESS' };
  } catch (_) {
    return null;
  }
}

/**
 * Get persistent task counts for status line
 */
function getPersistentTaskCounts() {
  const ptDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
  if (!Database || !fs.existsSync(ptDbPath)) {
    return null;
  }
  try {
    const db = new Database(ptDbPath, { readonly: true });
    const active = db.prepare("SELECT COUNT(*) as count FROM persistent_tasks WHERE status = 'active'").get();
    const count = active?.count || 0;
    if (count === 0) { db.close(); return null; }

    // Check for dead monitors
    const monitors = db.prepare("SELECT monitor_pid FROM persistent_tasks WHERE status = 'active' AND monitor_pid IS NOT NULL").all();
    let dead = 0;
    for (const m of monitors) {
      try { process.kill(m.monitor_pid, 0); } catch (_) { dead++; }
    }
    db.close();
    return { active: count, dead };
  } catch (_) { /* cleanup - failure expected */
    return null;
  }
}

/**
 * Format token count for display (e.g., 1.2M, 500K)
 */
function formatTokens(tokens) {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(1)}M`;
  } else if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(0)}K`;
  }
  return `${tokens}`;
}

/**
 * Format hours as human readable (e.g., "2h", "3d")
 */
function formatHours(hours) {
  if (hours >= 24) {
    const days = Math.round(hours / 24);
    return `${days}d`;
  }
  return `${Math.round(hours)}h`;
}

/**
 * Build a text progress bar with eighth-block precision.
 * Uses █▉▊▋▌▍▎▏ for sub-character fill granularity.
 */
function progressBar(percent, width = 10) {
  // ▏▎▍▌▋▊▉ — 1/8 through 7/8 fill
  const EIGHTHS = ['\u258F', '\u258E', '\u258D', '\u258C', '\u258B', '\u258A', '\u2589'];
  const exactFill = (Math.min(100, Math.max(0, percent)) / 100) * width;
  let fullBlocks = Math.floor(exactFill);
  const fractional = Math.round((exactFill - fullBlocks) * 8);
  if (fractional === 8) fullBlocks++;
  let bar = '\u2588'.repeat(fullBlocks);
  if (fullBlocks < width) {
    if (fractional > 0 && fractional < 8) {
      bar += EIGHTHS[fractional - 1];
      bar += '\u2591'.repeat(width - fullBlocks - 1);
    } else {
      bar += '\u2591'.repeat(width - fullBlocks);
    }
  }
  return bar;
}


/**
 * Get the current interactive session's context window token count.
 * Uses the shared compact-session module for consistent token calculation.
 *
 * @returns {number | null} Current context tokens or null if unavailable
 */
function getCurrentSessionContextTokens() {
  try {
    const sessionFile = findMostRecentSession(PROJECT_DIR);
    if (!sessionFile) return null;
    const result = getSharedContextTokens(sessionFile);
    return result?.totalContextTokens ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve OAuth access token from multiple sources (matching dashboard resolution order).
 * 1. CLAUDE_CODE_OAUTH_TOKEN env var
 * 2. macOS Keychain
 * 3. CLAUDE_CONFIG_DIR/.credentials.json
 * 4. ~/.claude/.credentials.json
 */
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
    } catch {
      // Keychain entry not found — fall through
    }
  }

  const configDir = process.env['CLAUDE_CONFIG_DIR'];
  if (configDir) {
    try {
      const configCredsPath = path.join(configDir, '.credentials.json');
      if (fs.existsSync(configCredsPath)) {
        const creds = JSON.parse(fs.readFileSync(configCredsPath, 'utf8'));
        const token = creds.claudeAiOauth?.accessToken;
        if (token) return token;
      }
    } catch {
      // Fall through
    }
  }

  try {
    if (fs.existsSync(CREDENTIALS_PATH)) {
      const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
      const token = creds.claudeAiOauth?.accessToken;
      if (token) return token;
    }
  } catch {
    // Fall through
  }

  return null;
}

/**
 * Fetch quota status and account email from Anthropic API.
 * Usage and profile endpoints are called in parallel.
 */
async function getQuotaStatus() {
  const emptyStatus = { five_hour: null, seven_day: null, email: null, mode: null, error: null };

  const token = getOAuthToken();
  if (!token) {
    // No OAuth — check for API key
    if (process.env.ANTHROPIC_API_KEY) {
      return { ...emptyStatus, mode: 'api_key' };
    }
    return { ...emptyStatus, error: 'no-token' };
  }

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'claude-code/2.1.14',
    'anthropic-beta': ANTHROPIC_BETA_HEADER,
  };

  try {
    const [usageResponse, profileResponse] = await Promise.all([
      fetch(ANTHROPIC_API_URL, { method: 'GET', headers }),
      fetch(ANTHROPIC_PROFILE_URL, { method: 'GET', headers }),
    ]);

    let email = null;
    if (profileResponse.ok) {
      try {
        const profile = await profileResponse.json();
        email = profile.account?.email || null;
      } catch {
        // Profile parse failed — non-fatal
      }
    }

    if (!usageResponse.ok) {
      return { ...emptyStatus, email, error: `api-${usageResponse.status}` };
    }

    const data = await usageResponse.json();

    const parseReset = (isoDate) => {
      const resetTime = new Date(isoDate).getTime();
      const hours = (resetTime - Date.now()) / (1000 * 60 * 60);
      return Math.max(0, hours);
    };

    return {
      five_hour: data.five_hour ? {
        utilization: data.five_hour.utilization,
        resets_in_hours: parseReset(data.five_hour.resets_at),
      } : null,
      seven_day: data.seven_day ? {
        utilization: data.seven_day.utilization,
        resets_in_hours: parseReset(data.seven_day.resets_at),
      } : null,
      email,
      mode: 'subscription',
      error: null,
    };
  } catch (err) {
    return { ...emptyStatus, error: err.message };
  }
}

/**
 * Main entry point
 */
async function main() {
  // Skip for spawned sessions
  if (process.env.CLAUDE_SPAWNED_SESSION === 'true') {
    console.log(JSON.stringify({
      continue: true,
      suppressOutput: true,
    }));
    return;
  }

  // Skip for slash commands (contain GENTYR sentinel markers or raw /command-name)
  try {
    const stdin = fs.readFileSync('/dev/stdin', 'utf-8');
    let prompt = stdin;
    try {
      const parsed = JSON.parse(stdin);
      if (typeof parsed.prompt === 'string') prompt = parsed.prompt;
    } catch (err) {
      console.error('[cto-notification-hook] Warning:', err.message);
      // Not JSON — use raw stdin
    }
    if (prompt.includes('<!-- HOOK:GENTYR:') || /^\/[\w-]+$/.test(prompt.trim())) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }
  } catch (err) {
    console.error('[cto-notification-hook] Warning:', err.message);
    // No stdin available — continue normally
  }

  // Gather all metrics (quota is async, session metrics use incremental cache)
  const gitContext = getGitContext();
  const sessionMetricsCached = getSessionMetricsCached();
  const planSummary = getPlanSummary();
  const releaseStatus = getReleaseStatus();
  const [quota, deputyCto, unreadReports, autonomousMode, todoCounts] = await Promise.all([
    getQuotaStatus(),
    Promise.resolve(getDeputyCtoCounts()),
    Promise.resolve(getUnreadReportsCount()),
    Promise.resolve(getAutonomousModeStatus()),
    Promise.resolve(getTodoCounts()),
  ]);
  const tokenUsage = sessionMetricsCached.tokens;
  const sessionMetrics = { task: sessionMetricsCached.taskSessions, user: sessionMetricsCached.userSessions };

  // Check if commits are blocked
  const isCritical = deputyCto.pending > 0 || unreadReports > 0;

  // Build git context label
  let gitLabel = '';
  if (gitContext) {
    gitLabel = gitContext.worktreeName
      ? `[${gitContext.branch} | wt:${gitContext.worktreeName}]`
      : `[${gitContext.branch}]`;
  }

  // Build autonomous status part
  let autonomousPart = '';
  if (autonomousMode.enabled) {
    if (autonomousMode.nextRunMinutes === null) {
      autonomousPart = 'Deputy: ON';
    } else if (autonomousMode.nextRunMinutes === 0) {
      autonomousPart = 'Deputy: ON (ready)';
    } else {
      autonomousPart = `Deputy: ON (${autonomousMode.nextRunMinutes}min)`;
    }
  } else {
    autonomousPart = 'Deputy: OFF';
  }

  // Build quota status part with graphical bars (used in both compact and multi-line modes)
  let quotaPart = '';
  if (quota.mode === 'api_key') {
    quotaPart = 'Auth: API Key (no usage quota available)';
  } else if (!quota.error && quota.five_hour && quota.seven_day) {
    const fh = quota.five_hour;
    const sd = quota.seven_day;
    const emailLabel = quota.email ? ` (${quota.email})` : '';
    quotaPart = `Quota${emailLabel}: 5h ${progressBar(fh.utilization, 8)} ${Math.round(fh.utilization)}% (resets ${formatHours(fh.resets_in_hours)}) | 7d ${progressBar(sd.utilization, 8)} ${Math.round(sd.utilization)}% (resets ${formatHours(sd.resets_in_hours)})`;
  }

  // Build message based on state
  let message;
  if (isCritical) {
    // Critical blocking mode - compact format
    const parts = [];
    if (releaseStatus) {
      parts.push(releaseStatus.label);
    }
    const itemCount = deputyCto.pending + unreadReports;
    const blockingCount = getBlockingQueueCount();
    if (blockingCount > 0) {
      parts.push(`${blockingCount} BLOCKING`);
    }
    const criticalDrift = getPreviewDriftFromState();
    if (criticalDrift > 0) {
      parts.push(`STAGING: ${criticalDrift} behind`);
    }
    parts.push(`${itemCount} pending item(s)`);
    if (quotaPart) parts.push(quotaPart);
    parts.push(`${formatTokens(tokenUsage)} tokens`);
    const criticalContextTokens = getCurrentSessionContextTokens();
    if (criticalContextTokens !== null) {
      parts.push(`${formatTokens(criticalContextTokens)} ctx`);
    }
    parts.push(autonomousPart);
    message = `${gitLabel ? gitLabel + ' ' : ''}MAIN BLOCKED: ${parts.join(' | ')}. Use /deputy-cto to address.`;
  } else {
    // Normal CTO report format - multi-line for readability
    const lines = [];

    // Line 0: Git context (branch + worktree)
    if (gitLabel) {
      lines.push(gitLabel);
    }

    // Line 0b: Active release status
    if (releaseStatus) {
      lines.push(releaseStatus.label);
    }

    // Line 1: Quota status (reuse quotaPart built above)
    if (quotaPart) {
      lines.push(quotaPart);
    }

    // Line 1b: Context window usage
    const contextTokens = getCurrentSessionContextTokens();
    if (contextTokens !== null) {
      const contextPct = Math.round((contextTokens / 1000000) * 100);
      lines.push(`Context: ${formatTokens(contextTokens)} / 1M ${progressBar(contextPct, 8)} ${contextPct}%`);
    }

    // Line 2: Token usage, sessions, and TODOs
    const todosPart = todoCounts.active > 0
      ? `TODOs: ${todoCounts.queued} queued, ${todoCounts.active} active`
      : `TODOs: ${todoCounts.queued} queued`;
    lines.push(`Usage (30d): ${formatTokens(tokenUsage)} tokens | ${sessionMetrics.task} task / ${sessionMetrics.user} user sessions | ${todosPart} | ${autonomousPart}`);

    // Line 3: Plans (if any active)
    if (planSummary) {
      lines.push(planSummary);
    }

    // Line 3b: Persistent tasks (if any active)
    const ptCounts = getPersistentTaskCounts();
    if (ptCounts) {
      const deadStr = ptCounts.dead > 0 ? ` (${ptCounts.dead} dead monitor${ptCounts.dead > 1 ? 's' : ''})` : '';
      lines.push(`Persistent: ${ptCounts.active} active${deadStr}`);
    }

    // Line 3c: Preview → Staging drift
    const previewDrift = getPreviewDriftFromState();
    if (previewDrift > 0) {
      lines.push(`Staging: ${previewDrift} commit${previewDrift === 1 ? '' : 's'} behind preview`);
    }

    // Line 4: Blocking queue (work-stopping items — shown above pending)
    const blockingCount = getBlockingQueueCount();
    if (blockingCount > 0) {
      lines.push(`BLOCKED: ${blockingCount} item(s) blocking work — resolve bypass requests or use /deputy-cto`);
    }

    // Line 5: Pending items (if any)
    const ctoPending = [];
    if (deputyCto.pending > 0) {
      ctoPending.push(`${deputyCto.pending} CTO decision(s)`);
    }
    if (unreadReports > 0) {
      ctoPending.push(`${unreadReports} unread report(s)`);
    }
    if (ctoPending.length > 0) {
      lines.push(`Pending: ${ctoPending.join(', ')}`);
    }

    message = lines.join('\n');
  }

  // Append pending bypass request details to message (both critical and normal paths)
  const pendingBypassRequests = getPendingBypassRequests();
  if (pendingBypassRequests.length > 0) {
    const bypassLines = ['\n=== ACTION REQUIRED: Bypass Requests ==='];
    for (let i = 0; i < pendingBypassRequests.length; i++) {
      const req = pendingBypassRequests[i];
      const age = req.created_at ? `${Math.round((Date.now() - new Date(req.created_at).getTime()) / 60000)}m ago` : '';
      bypassLines.push(`${i + 1}. [${req.id}] "${req.task_title || 'Unknown'}" (${req.category || 'general'}) — ${req.summary || 'No summary'}${age ? ` [${age}]` : ''}`);
      bypassLines.push(`   -> resolve_bypass_request({ request_id: "${req.id}", decision: "approved"|"rejected", context: "..." })`);
    }
    message += bypassLines.join('\n');
  }

  console.log(JSON.stringify({
    continue: true,
    suppressOutput: false,
    systemMessage: message,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: message,
    },
  }));
}

main();
