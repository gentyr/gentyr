/**
 * Session Compaction Utilities
 *
 * Shared module for reading session context tokens, tracking compaction events,
 * and executing compaction on dead sessions via `claude --resume <id> -p "/compact"`.
 *
 * Used by: context-pressure-hook.js, session-queue.js (revival-time compaction),
 *          cto-notification-hook.js (context display), agent-tracker MCP server.
 *
 * @module lib/compact-session
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const TRACKER_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'compact-tracker.json');
const LOCK_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'compaction-in-progress.lock');
const TRACKER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ============================================================================
// Session Directory Resolution
// ============================================================================

/**
 * Get the session directory for a given project.
 * Tries both encoding conventions (with and without leading dash).
 */
export function getSessionDir(projectDir = PROJECT_DIR) {
  const projectsBase = path.join(os.homedir(), '.claude', 'projects');
  const encoded = projectDir.replace(/[^a-zA-Z0-9]/g, '-');

  // Try with leading dash first (most common)
  const withDash = path.join(projectsBase, encoded);
  try { if (fs.existsSync(withDash)) return withDash; } catch { /* fallthrough */ }

  // Try without leading dash
  const withoutDash = path.join(projectsBase, encoded.replace(/^-/, ''));
  try { if (fs.existsSync(withoutDash)) return withoutDash; } catch { /* fallthrough */ }

  // Default to the with-dash convention
  return withDash;
}

/**
 * Find a session JSONL file by session ID.
 * Returns the full path or null if not found.
 */
export function findSessionJsonl(sessionId, projectDir = PROJECT_DIR) {
  const sessionDir = getSessionDir(projectDir);
  const filePath = path.join(sessionDir, `${sessionId}.jsonl`);
  try {
    if (fs.existsSync(filePath)) return filePath;
  } catch { /* non-fatal */ }
  return null;
}

// ============================================================================
// Token Reading
// ============================================================================

/**
 * Read the last N bytes of a file efficiently using fd-based seeking.
 * Returns the string content of the tail.
 */
function readFileTail(filePath, bytes = 16384) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return '';
    const readSize = Math.min(bytes, stat.size);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/**
 * Extract the current context window token count from a session JSONL file.
 *
 * Reads the last 16KB of the file, finds the most recent assistant entry
 * with a `message.usage` object, and calculates context tokens as:
 *   input_tokens + cache_read_input_tokens + cache_creation_input_tokens
 *
 * This represents the current context window size (not cumulative usage).
 *
 * @param {string} sessionFilePath - Full path to the session JSONL file
 * @returns {{ totalContextTokens: number, outputTokens: number, timestamp: string } | null}
 */
export function getSessionContextTokens(sessionFilePath) {
  const tail = readFileTail(sessionFilePath, 16384);
  if (!tail) return null;

  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      const usage = entry.message?.usage;
      if (usage && entry.type === 'assistant') {
        const inputTokens = usage.input_tokens || 0;
        const cacheRead = usage.cache_read_input_tokens || 0;
        const cacheCreation = usage.cache_creation_input_tokens || 0;
        const outputTokens = usage.output_tokens || 0;
        return {
          totalContextTokens: inputTokens + cacheRead + cacheCreation,
          outputTokens,
          timestamp: entry.timestamp || null,
        };
      }
    } catch {
      // Partial line at the start of tail — skip
    }
  }
  return null;
}

/**
 * Find the most recently modified session JSONL in a session directory.
 * Useful for finding the current interactive session.
 *
 * @param {string} [projectDir] - Project directory (defaults to PROJECT_DIR)
 * @returns {string | null} Full path to the most recent JSONL file
 */
export function findMostRecentSession(projectDir = PROJECT_DIR) {
  const sessionDir = getSessionDir(projectDir);
  try {
    const files = fs.readdirSync(sessionDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        try {
          const stat = fs.statSync(path.join(sessionDir, f));
          return { name: f, mtime: stat.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    if (files.length === 0) return null;
    files.sort((a, b) => b.mtime - a.mtime);
    return path.join(sessionDir, files[0].name);
  } catch {
    return null;
  }
}

// ============================================================================
// Compact Tracker
// ============================================================================

/**
 * Read the compact tracker state file.
 * Returns the parsed JSON or an empty object on error.
 */
export function readCompactTracker() {
  try {
    if (!fs.existsSync(TRACKER_PATH)) return {};
    return JSON.parse(fs.readFileSync(TRACKER_PATH, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Write the compact tracker state file atomically.
 * Prunes entries older than 7 days.
 */
export function writeCompactTracker(data) {
  try {
    // Prune old entries
    const now = Date.now();
    for (const [key, entry] of Object.entries(data)) {
      if (entry?.lastCompactAt && (now - new Date(entry.lastCompactAt).getTime()) > TRACKER_MAX_AGE_MS) {
        delete data[key];
      }
    }

    const dir = path.dirname(TRACKER_PATH);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = TRACKER_PATH + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    fs.renameSync(tmpPath, TRACKER_PATH);
  } catch {
    // Non-fatal
  }
}

/**
 * Record a compaction event for a session.
 */
export function recordCompactEvent(sessionId, preTokens) {
  const tracker = readCompactTracker();
  const existing = tracker[sessionId] || {};
  tracker[sessionId] = {
    lastCompactAt: new Date().toISOString(),
    lastCompactTokens: preTokens,
    compactCount: (existing.compactCount || 0) + 1,
    compactRequested: false,
  };
  writeCompactTracker(tracker);
}

/**
 * Get milliseconds since the last compaction for a session.
 * Returns Infinity if never compacted.
 */
export function getTimeSinceLastCompact(sessionId) {
  const tracker = readCompactTracker();
  const entry = tracker[sessionId];
  if (!entry?.lastCompactAt) return Infinity;
  return Date.now() - new Date(entry.lastCompactAt).getTime();
}

// ============================================================================
// Session Compaction Execution
// ============================================================================

/**
 * Compact a dead session if its context exceeds thresholds.
 *
 * Runs `claude --resume <sessionId> -p "/compact"` from the project directory.
 * Only safe on DEAD sessions — running sessions will be killed.
 *
 * Trigger logic: token threshold OR (time threshold AND tokens above half the minimum).
 * This prevents compacting brand-new sessions with trivial context.
 *
 * @param {string} sessionId - The session UUID
 * @param {string} projectDir - Project directory to run from (determines session scope)
 * @param {object} [options]
 * @param {number} [options.timeoutMs=120000] - Timeout for the compact command
 * @param {number} [options.minTokens=200000] - Minimum context tokens to trigger compaction
 * @param {number} [options.maxMinutesSinceCompact=30] - Max minutes since last compact
 * @returns {{ preTokens: number, compactedAt: string } | null} Result or null if skipped
 */
export function compactSessionIfNeeded(sessionId, projectDir, options = {}) {
  const {
    timeoutMs = 120000,
    minTokens = 200000,
    maxMinutesSinceCompact = 30,
  } = options;

  // Find the session file
  const sessionFile = findSessionJsonl(sessionId, projectDir);
  if (!sessionFile) return null;

  // Check token count
  const tokenInfo = getSessionContextTokens(sessionFile);
  const currentTokens = tokenInfo?.totalContextTokens || 0;

  // Check time since last compact
  const msSinceCompact = getTimeSinceLastCompact(sessionId);
  const minutesSinceCompact = msSinceCompact / (60 * 1000);

  // Decide whether to compact:
  // - Token threshold alone: always compact if above minTokens
  // - Time threshold: only compact if ALSO above half the token minimum
  //   (prevents compacting brand-new sessions with trivial context)
  const tokenTriggered = currentTokens >= minTokens;
  const timeTriggered = minutesSinceCompact >= maxMinutesSinceCompact && currentTokens >= Math.floor(minTokens / 2);

  // Also trigger if the agent explicitly requested compaction via request_self_compact
  const tracker = readCompactTracker();
  const agentRequested = tracker[sessionId]?.compactRequested === true;
  if (!tokenTriggered && !timeTriggered && !agentRequested) return null;

  // Concurrency guard: atomic lock acquisition via O_EXCL
  let lockFd = -1;
  try {
    fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
    lockFd = fs.openSync(LOCK_PATH, 'wx'); // O_CREAT | O_EXCL — fails if exists
    fs.writeSync(lockFd, JSON.stringify({
      pid: process.pid,
      sessionId,
      createdAt: new Date().toISOString(),
    }));
    fs.closeSync(lockFd);
    lockFd = -1;
  } catch (err) {
    if (lockFd >= 0) { try { fs.closeSync(lockFd); } catch { /* */ } }

    if (err.code === 'EEXIST') {
      // Lock exists — check if stale (holder dead or lock > 5 min old)
      try {
        const lockData = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
        let stale = false;
        if (lockData.pid) {
          try { process.kill(lockData.pid, 0); } catch { stale = true; }
        }
        if (!stale && lockData.createdAt) {
          stale = (Date.now() - new Date(lockData.createdAt).getTime()) > 5 * 60 * 1000;
        }
        if (!stale) return null; // Lock held by live process — skip

        // Break stale lock and retry
        fs.unlinkSync(LOCK_PATH);
        fs.writeFileSync(LOCK_PATH, JSON.stringify({
          pid: process.pid, sessionId, createdAt: new Date().toISOString(),
        }));
      } catch {
        return null; // Can't break lock — skip
      }
    } else {
      // Other error — proceed without lock (fail-open)
    }
  }

  try {
    // Run compaction
    execFileSync('claude', [
      '--resume', sessionId,
      '-p', '/compact',
      '--permission-mode', 'bypassPermissions',
    ], {
      cwd: projectDir,
      timeout: timeoutMs,
      stdio: 'pipe',
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    });

    const compactedAt = new Date().toISOString();
    recordCompactEvent(sessionId, currentTokens);

    return { preTokens: currentTokens, compactedAt };
  } finally {
    // Release lock
    try { fs.unlinkSync(LOCK_PATH); } catch { /* non-fatal */ }
  }
}
