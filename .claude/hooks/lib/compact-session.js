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

// ============================================================================
// Session Directory Resolution
// ============================================================================

/**
 * Encode a project directory path into the Claude Code session directory name.
 * Matches the encoding used by Claude Code for ~/.claude/projects/<encoded>/.
 */
export function encodeProjectDir(projectDir) {
  return '-' + projectDir.replace(/[^a-zA-Z0-9]/g, '-').replace(/^-/, '');
}

/**
 * Get the session directory for a given project.
 */
export function getSessionDir(projectDir = PROJECT_DIR) {
  const encoded = encodeProjectDir(projectDir);
  return path.join(os.homedir(), '.claude', 'projects', encoded);
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
function readFileTail(filePath, bytes = 8192) {
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
 * Reads the last 8KB of the file, finds the most recent assistant entry
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

  // Split into lines and parse backward to find the last usage entry
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
 */
export function writeCompactTracker(data) {
  try {
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

  // Decide whether to compact
  const tokenTriggered = currentTokens >= minTokens;
  const timeTriggered = minutesSinceCompact >= maxMinutesSinceCompact;

  if (!tokenTriggered && !timeTriggered) return null;

  // Concurrency guard: check lockfile
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const lockData = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
      // Check if the lock holder is still alive
      if (lockData.pid) {
        try {
          process.kill(lockData.pid, 0);
          // Lock holder alive — skip
          return null;
        } catch {
          // Lock holder dead — break stale lock
        }
      }
      // Check age — break locks older than 5 minutes
      if (lockData.createdAt && (Date.now() - new Date(lockData.createdAt).getTime()) < 5 * 60 * 1000) {
        return null;
      }
    }
  } catch {
    // Lock check failed — proceed (fail-open for the lock check)
  }

  // Acquire lock
  try {
    fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
    fs.writeFileSync(LOCK_PATH, JSON.stringify({
      pid: process.pid,
      sessionId,
      createdAt: new Date().toISOString(),
    }));
  } catch {
    // Non-fatal — proceed without lock
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
    try {
      fs.unlinkSync(LOCK_PATH);
    } catch {
      // Non-fatal
    }
  }
}
