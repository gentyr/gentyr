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
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Try to import better-sqlite3
let Database = null;
try {
  Database = (await import('better-sqlite3')).default;
} catch {
  // Database not available
}

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const DEPUTY_CTO_DB = path.join(PROJECT_DIR, '.claude', 'deputy-cto.db');
const CTO_REPORTS_DB = path.join(PROJECT_DIR, '.claude', 'cto-reports.db');
const TODO_DB = path.join(PROJECT_DIR, '.claude', 'todo.db');
const AGENT_TRACKER_HISTORY = path.join(PROJECT_DIR, '.claude', 'state', 'agent-tracker-history.json');
const AUTONOMOUS_CONFIG_PATH = path.join(PROJECT_DIR, '.claude', 'autonomous-mode.json');
const AUTOMATION_STATE_PATH = path.join(PROJECT_DIR, '.claude', 'hourly-automation-state.json');
const KEY_ROTATION_STATE_PATH = path.join(os.homedir(), '.claude', 'api-key-rotation.json');
const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const ANTHROPIC_API_URL = 'https://api.anthropic.com/api/oauth/usage';
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
  } catch {
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
  } catch {}
  return { files: {}, totals: { tokens: 0, taskSessions: 0, userSessions: 0 } };
}

/**
 * Save metrics cache to disk
 */
function saveMetricsCache(cache) {
  try {
    fs.writeFileSync(METRICS_CACHE_PATH, JSON.stringify(cache), 'utf8');
  } catch {}
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
          if (msg && msg.startsWith('[Task]')) {
            isTask = true;
          }
          break;
        }
      } catch {}
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
      } catch {}
    }
  } catch {}

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
      } catch {}
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
  } catch {}

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
  } catch {
    return { queued: 0, active: 0 };
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
 * Build a simple text progress bar
 */
function progressBar(percent, width = 10) {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
}

/**
 * Get aggregate quota from api-key-rotation.json (active keys only)
 * Groups keys by account_uuid to deduplicate same-account tokens.
 * Returns { activeCount, fiveHourPct, sevenDayPct, accounts } or null
 * Percentages are of total capacity (average across unique accounts)
 */
function getAggregateQuota() {
  if (!fs.existsSync(KEY_ROTATION_STATE_PATH)) {
    return null;
  }

  try {
    const state = JSON.parse(fs.readFileSync(KEY_ROTATION_STATE_PATH, 'utf8'));
    if (!state || state.version !== 1 || !state.keys) {
      return null;
    }

    // Group by account_uuid to deduplicate same-account tokens
    const accountMap = new Map();

    for (const keyData of Object.values(state.keys)) {
      if ((keyData.status === 'active' || keyData.status === 'exhausted') && keyData.last_usage) {
        const dedupeKey = keyData.account_uuid || `fp:${keyData.last_usage.seven_day}:${keyData.last_usage.seven_day_sonnet}`;
        if (!accountMap.has(dedupeKey)) {
          accountMap.set(dedupeKey, {
            email: keyData.account_email || null,
            fiveHour: keyData.last_usage.five_hour || 0,
            sevenDay: keyData.last_usage.seven_day || 0,
            sevenDaySonnet: keyData.last_usage.seven_day_sonnet || 0,
          });
        }
      }
    }

    // Cross-match fingerprint-based entries (null-UUID keys) against UUID-bearing entries.
    // If a null-UUID key has the same seven_day + seven_day_sonnet as a UUID-bearing key,
    // it's the same account — merge it to prevent "unknown" in the display.
    const fpKeys = [...accountMap.keys()].filter(k => k.startsWith('fp:'));
    for (const fpKey of fpKeys) {
      const fpEntry = accountMap.get(fpKey);
      for (const [uuidKey, uuidEntry] of accountMap) {
        if (uuidKey.startsWith('fp:') || !uuidEntry.email) continue;
        if (uuidEntry.sevenDay === fpEntry.sevenDay && uuidEntry.sevenDaySonnet === fpEntry.sevenDaySonnet) {
          // Same account — take the higher fiveHour value
          uuidEntry.fiveHour = Math.max(uuidEntry.fiveHour, fpEntry.fiveHour);
          accountMap.delete(fpKey);
          break;
        }
      }
    }

    if (accountMap.size === 0) {
      return null;
    }

    const accounts = Array.from(accountMap.values());
    const fiveHourSum = accounts.reduce((sum, a) => sum + a.fiveHour, 0);
    const sevenDaySum = accounts.reduce((sum, a) => sum + a.sevenDay, 0);

    return {
      activeCount: accounts.length,
      fiveHourPct: Math.round(fiveHourSum / accounts.length),
      sevenDayPct: Math.round(sevenDaySum / accounts.length),
      accounts,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch quota status from Anthropic API
 */
async function getQuotaStatus() {
  const emptyStatus = { five_hour: null, seven_day: null, error: null };

  if (!fs.existsSync(CREDENTIALS_PATH)) {
    return { ...emptyStatus, error: 'no-creds' };
  }

  try {
    const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    const token = creds.claudeAiOauth?.accessToken;
    if (!token) {
      return { ...emptyStatus, error: 'no-token' };
    }

    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'claude-code/2.1.14',
        'anthropic-beta': ANTHROPIC_BETA_HEADER,
      },
    });

    if (!response.ok) {
      return { ...emptyStatus, error: `api-${response.status}` };
    }

    const data = await response.json();

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
    } catch {
      // Not JSON — use raw stdin
    }
    if (prompt.includes('<!-- HOOK:GENTYR:') || /^\/[\w-]+$/.test(prompt.trim())) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }
  } catch {
    // No stdin available — continue normally
  }

  // Gather all metrics (quota is async, session metrics use incremental cache)
  const sessionMetricsCached = getSessionMetricsCached();
  const aggregateQuota = getAggregateQuota();
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
  const isCritical = deputyCto.rejections > 0;

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

  // Build quota status part (compact for critical mode)
  let quotaPart = '';
  if (aggregateQuota && aggregateQuota.activeCount > 1) {
    // Compact aggregate display for critical mode (% of total capacity)
    quotaPart = `Quota (${aggregateQuota.activeCount} accounts): 5h ${aggregateQuota.fiveHourPct}% 7d ${aggregateQuota.sevenDayPct}%`;
  } else if (!quota.error && quota.five_hour && quota.seven_day) {
    // Single key display
    const fiveHour = `5h: ${Math.round(quota.five_hour.utilization)}%`;
    const sevenDay = `7d: ${Math.round(quota.seven_day.utilization)}%`;
    quotaPart = `Quota ${fiveHour} ${sevenDay}`;
  }

  // Build message based on state
  let message;
  if (isCritical) {
    // Critical blocking mode - compact format
    const parts = [];
    parts.push(`${deputyCto.rejections} rejection(s)`);
    if (quotaPart) parts.push(quotaPart);
    parts.push(`${formatTokens(tokenUsage)} tokens`);
    parts.push(autonomousPart);
    message = `COMMITS BLOCKED: ${parts.join(' | ')}. Use /deputy-cto to address.`;
  } else {
    // Normal CTO report format - multi-line for readability
    const lines = [];

    // Line 1: Quota status - use aggregate if available, otherwise single-key
    if (aggregateQuota && aggregateQuota.activeCount > 1) {
      // Multi-account aggregate display (% of total capacity)
      const fhBar = progressBar(aggregateQuota.fiveHourPct, 8);
      const sdBar = progressBar(aggregateQuota.sevenDayPct, 8);
      lines.push(`Quota (${aggregateQuota.activeCount} accounts): 5h ${fhBar} ${aggregateQuota.fiveHourPct}% | 7d ${sdBar} ${aggregateQuota.sevenDayPct}%`);

      // Accounts line with emails and per-account 5h usage
      if (aggregateQuota.accounts) {
        const accountParts = aggregateQuota.accounts.map(a => {
          const label = a.email || 'unknown';
          return `${label} (${Math.round(a.fiveHour)}% 5h)`;
        });
        lines.push(`Accounts: ${accountParts.join(' | ')}`);
      }
    } else if (quota.five_hour && quota.seven_day) {
      // Single-key display with reset times
      const fh = quota.five_hour;
      const sd = quota.seven_day;
      lines.push(`Quota: 5-hour ${progressBar(fh.utilization, 8)} ${Math.round(fh.utilization)}% (resets ${formatHours(fh.resets_in_hours)}) | 7-day ${progressBar(sd.utilization, 8)} ${Math.round(sd.utilization)}% (resets ${formatHours(sd.resets_in_hours)})`);
    }

    // Line 2: Token usage, sessions, and TODOs
    const todosPart = todoCounts.active > 0
      ? `TODOs: ${todoCounts.queued} queued, ${todoCounts.active} active`
      : `TODOs: ${todoCounts.queued} queued`;
    lines.push(`Usage (30d): ${formatTokens(tokenUsage)} tokens | ${sessionMetrics.task} task / ${sessionMetrics.user} user sessions | ${todosPart} | ${autonomousPart}`);

    // Line 3: Pending items (if any)
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

  console.log(JSON.stringify({
    continue: true,
    suppressOutput: false,
    systemMessage: message,
  }));
}

main();
