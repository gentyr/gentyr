/**
 * Session Signals — File-based inter-agent communication system.
 *
 * Three priority tiers:
 *   note        — Agent → Agent: helpful FYI
 *   instruction — Deputy-CTO → Agent: urgent, must acknowledge
 *   directive   — CTO → Agent (via deputy-CTO): mandatory override
 *
 * Signal storage: .claude/state/session-signals/<target-agent-id>-<timestamp>.json
 * Communication log: .claude/state/session-comms.log (JSON-lines, append-only)
 *
 * @module lib/session-signals
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// ============================================================================
// Worktree Resolution
// ============================================================================

/**
 * Resolve the main project directory even when running inside a git worktree.
 *
 * In a worktree, `.git` is a FILE containing "gitdir: /path/to/.git/worktrees/xxx".
 * We navigate up two levels from that gitdir to reach the main tree root.
 *
 * @param {string} [startDir] - Directory to start from. Defaults to CLAUDE_PROJECT_DIR or cwd.
 * @returns {string} Main project directory path
 */
export function getMainProjectDir(startDir) {
  const projectDir = startDir || PROJECT_DIR;
  const gitPath = path.join(projectDir, '.git');
  try {
    const stat = fs.lstatSync(gitPath);
    if (stat.isFile()) {
      // Worktree: .git is a file containing "gitdir: /path/to/main/.git/worktrees/xxx"
      const content = fs.readFileSync(gitPath, 'utf8').trim();
      const match = content.match(/^gitdir:\s*(.+)/);
      if (match) {
        const gitDir = path.resolve(projectDir, match[1]);
        // Navigate from .git/worktrees/xxx -> .git -> parent = main tree root
        return path.dirname(path.resolve(gitDir, '..', '..'));
      }
    }
  } catch {
    // Not a worktree or .git doesn't exist, use projectDir as-is
  }
  return projectDir;
}

// ============================================================================
// Path Helpers
// ============================================================================

function getSignalDir(projectDir) {
  return path.join(projectDir || getMainProjectDir(), '.claude', 'state', 'session-signals');
}

function getCommsLogPath(projectDir) {
  return path.join(projectDir || PROJECT_DIR, '.claude', 'state', 'session-comms.log');
}

function getQueueDbPath(projectDir) {
  return path.join(projectDir || PROJECT_DIR, '.claude', 'state', 'session-queue.db');
}

// ============================================================================
// ID Generation
// ============================================================================

function generateSignalId() {
  return `sig-${crypto.randomBytes(4).toString('hex')}`;
}

// ============================================================================
// Directory Initialization
// ============================================================================

function ensureSignalDir(projectDir) {
  const signalDir = getSignalDir(projectDir);
  fs.mkdirSync(signalDir, { recursive: true });
  return signalDir;
}

// ============================================================================
// Comms Log
// ============================================================================

/**
 * Append a signal event to the communication log.
 * @param {object} signal - The signal object
 * @param {string} [projectDir]
 */
function appendCommsLog(signal, projectDir) {
  const logPath = getCommsLogPath(projectDir);
  const logDir = path.dirname(logPath);
  fs.mkdirSync(logDir, { recursive: true });

  const line = JSON.stringify({
    ts: signal.created_at,
    ...signal,
  }) + '\n';

  fs.appendFileSync(logPath, line);
}

// ============================================================================
// Atomic Write Helper
// ============================================================================

/**
 * Atomically write JSON to a file using tmp+rename pattern.
 * @param {string} filePath
 * @param {object} data
 */
function atomicWriteJson(filePath, data) {
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmpPath, filePath);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Send a signal to a specific agent.
 *
 * @param {object} opts
 * @param {string} opts.fromAgentId
 * @param {string} opts.fromAgentType
 * @param {string} opts.fromTaskTitle
 * @param {string} opts.toAgentId
 * @param {string} opts.toAgentType
 * @param {'note'|'instruction'|'directive'} opts.tier
 * @param {string} opts.message
 * @param {string} [opts.projectDir]
 * @returns {object} The created signal
 */
export function sendSignal({ fromAgentId, fromAgentType, fromTaskTitle, toAgentId, toAgentType, tier, message, projectDir }) {
  if (!fromAgentId) throw new Error('sendSignal: fromAgentId is required');
  if (!toAgentId) throw new Error('sendSignal: toAgentId is required');
  if (!tier) throw new Error('sendSignal: tier is required');
  if (!['note', 'instruction', 'directive'].includes(tier)) {
    throw new Error(`sendSignal: invalid tier "${tier}" — must be note, instruction, or directive`);
  }
  if (!message) throw new Error('sendSignal: message is required');

  const signalDir = ensureSignalDir(projectDir);
  const now = new Date().toISOString();
  const timestamp = Date.now();
  const id = generateSignalId();

  const signal = {
    id,
    from_agent_id: fromAgentId,
    from_agent_type: fromAgentType || 'unknown',
    from_task_title: fromTaskTitle || '',
    to_agent_id: toAgentId,
    to_agent_type: toAgentType || 'unknown',
    tier,
    message,
    created_at: now,
    read_at: null,
    acknowledged_at: null,
  };

  const filename = `${toAgentId}-${timestamp}-${id}.json`;
  const filePath = path.join(signalDir, filename);
  atomicWriteJson(filePath, signal);

  appendCommsLog(signal, projectDir);

  return signal;
}

/**
 * Read all pending (unread) signals for a given agent.
 * Marks each signal as read and rewrites the file.
 *
 * @param {string} agentId
 * @param {string} [projectDir]
 * @returns {object[]} Array of signal objects
 */
export function readPendingSignals(agentId, projectDir) {
  if (!agentId) throw new Error('readPendingSignals: agentId is required');

  const signalDir = getSignalDir(projectDir);
  if (!fs.existsSync(signalDir)) {
    return [];
  }

  let files;
  try {
    files = fs.readdirSync(signalDir);
  } catch (err) {
    console.error('[session-signals] readPendingSignals readdir error:', err.message);
    throw err;
  }

  // Filter to files targeting this agent
  const agentFiles = files.filter(f => f.startsWith(`${agentId}-`) && f.endsWith('.json'));
  const pending = [];
  const now = new Date().toISOString();

  for (const filename of agentFiles) {
    const filePath = path.join(signalDir, filename);
    let signal;

    try {
      signal = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      console.error(`[session-signals] Failed to read signal file ${filename}:`, err.message);
      // Non-fatal: skip this file
      continue;
    }

    if (signal.read_at === null) {
      // Mark as read
      signal.read_at = now;
      try {
        atomicWriteJson(filePath, signal);
      } catch (err) {
        console.error(`[session-signals] Failed to update signal file ${filename}:`, err.message);
        // Non-fatal: still return the signal
      }
      pending.push(signal);
    }
  }

  // Sort by created_at ascending (oldest first)
  pending.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  return pending;
}

/**
 * Acknowledge a signal (set acknowledged_at).
 *
 * @param {string} signalId
 * @param {string} [projectDir]
 * @returns {boolean} true if found and updated, false otherwise
 */
export function acknowledgeSignal(signalId, projectDir) {
  if (!signalId) throw new Error('acknowledgeSignal: signalId is required');

  const signalDir = getSignalDir(projectDir);
  if (!fs.existsSync(signalDir)) {
    return false;
  }

  let files;
  try {
    files = fs.readdirSync(signalDir);
  } catch (err) {
    console.error('[session-signals] acknowledgeSignal readdir error:', err.message);
    throw err;
  }

  for (const filename of files) {
    if (!filename.endsWith('.json')) continue;

    const filePath = path.join(signalDir, filename);
    let signal;

    try {
      signal = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
      continue;
    }

    if (signal.id === signalId) {
      signal.acknowledged_at = new Date().toISOString();
      try {
        atomicWriteJson(filePath, signal);
        return true;
      } catch (err) {
        console.error(`[session-signals] Failed to acknowledge signal ${signalId}:`, err.message);
        throw err;
      }
    }
  }

  return false;
}

/**
 * Get communication log entries, filtered by since/tier.
 *
 * @param {object} opts
 * @param {string} [opts.since] - ISO timestamp; only return entries after this
 * @param {'note'|'instruction'|'directive'} [opts.tier] - Filter by tier
 * @param {number} [opts.limit=50] - Maximum entries to return (last N)
 * @param {string} [opts.projectDir]
 * @returns {object[]} Array of log entries
 */
export function getSignalLog({ since, tier, limit = 50, projectDir } = {}) {
  const logPath = getCommsLogPath(projectDir);
  if (!fs.existsSync(logPath)) {
    return [];
  }

  let content;
  try {
    content = fs.readFileSync(logPath, 'utf8');
  } catch (err) {
    console.error('[session-signals] getSignalLog read error:', err.message);
    throw err;
  }

  const lines = content.split('\n').filter(l => l.trim());
  const entries = [];

  const sinceMs = since ? new Date(since).getTime() : 0;

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (_) {
      continue;
    }

    // Filter by since
    if (since && entry.ts) {
      const entryMs = new Date(entry.ts).getTime();
      if (entryMs <= sinceMs) continue;
    }

    // Filter by tier
    if (tier && entry.tier !== tier) continue;

    entries.push(entry);
  }

  // Return last N entries
  return entries.slice(-limit);
}

/**
 * Count unread signals for an agent. Fast path — O(readdir + targeted file reads).
 *
 * @param {string} agentId
 * @param {string} [projectDir]
 * @returns {number} Count of unread signals
 */
export function getUnreadCount(agentId, projectDir) {
  if (!agentId) throw new Error('getUnreadCount: agentId is required');

  const signalDir = getSignalDir(projectDir);
  if (!fs.existsSync(signalDir)) {
    return 0;
  }

  let files;
  try {
    files = fs.readdirSync(signalDir);
  } catch (err) {
    console.error('[session-signals] getUnreadCount readdir error:', err.message);
    return 0;
  }

  // Filter to files targeting this agent
  const agentFiles = files.filter(f => f.startsWith(`${agentId}-`) && f.endsWith('.json'));
  if (agentFiles.length === 0) return 0;

  let unread = 0;
  for (const filename of agentFiles) {
    const filePath = path.join(signalDir, filename);
    let signal;
    try {
      signal = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
      continue;
    }
    if (signal.read_at === null) {
      unread++;
    }
  }

  return unread;
}

/**
 * Broadcast a signal to all currently running agents (from session-queue.db).
 *
 * @param {object} opts
 * @param {string} opts.fromAgentId
 * @param {string} opts.fromAgentType
 * @param {string} opts.fromTaskTitle
 * @param {'note'|'instruction'|'directive'} opts.tier
 * @param {string} opts.message
 * @param {string[]} [opts.excludeAgentIds=[]]
 * @param {string} [opts.projectDir]
 * @returns {object[]} Array of created signals
 */
export function broadcastSignal({ fromAgentId, fromAgentType, fromTaskTitle, tier, message, excludeAgentIds = [], projectDir }) {
  if (!fromAgentId) throw new Error('broadcastSignal: fromAgentId is required');
  if (!tier) throw new Error('broadcastSignal: tier is required');
  if (!message) throw new Error('broadcastSignal: message is required');

  const queueDbPath = getQueueDbPath(projectDir);
  if (!fs.existsSync(queueDbPath)) {
    return [];
  }

  let db;
  try {
    db = new Database(queueDbPath, { readonly: true });
  } catch (err) {
    console.error('[session-signals] broadcastSignal DB open error:', err.message);
    throw err;
  }

  let runningAgents;
  try {
    runningAgents = db.prepare(
      "SELECT agent_id, agent_type, title FROM queue_items WHERE status = 'running' AND lane != 'gate'"
    ).all();
  } finally {
    try { db.close(); } catch (_) { /* best-effort */ }
  }

  const excludeSet = new Set(excludeAgentIds);
  excludeSet.add(fromAgentId); // Never send to self

  const created = [];
  for (const agent of runningAgents) {
    if (!agent.agent_id || excludeSet.has(agent.agent_id)) continue;

    try {
      const signal = sendSignal({
        fromAgentId,
        fromAgentType,
        fromTaskTitle,
        toAgentId: agent.agent_id,
        toAgentType: agent.agent_type || 'unknown',
        tier,
        message,
        projectDir,
      });
      created.push(signal);
    } catch (err) {
      console.error(`[session-signals] broadcastSignal failed for agent ${agent.agent_id}:`, err.message);
      // Non-fatal: continue broadcasting to other agents
    }
  }

  return created;
}

/**
 * Delete signal files older than maxAgeHours. Also trims session-comms.log to last 24h.
 *
 * @param {number} [maxAgeHours=24]
 * @param {string} [projectDir]
 * @returns {{ deletedFiles: number, trimmedLog: boolean }}
 */
export function cleanupOldSignals(maxAgeHours = 24, projectDir) {
  const signalDir = getSignalDir(projectDir);
  const logPath = getCommsLogPath(projectDir);
  const cutoffMs = Date.now() - maxAgeHours * 60 * 60 * 1000;

  let deletedFiles = 0;
  let trimmedLog = false;

  // Clean up old signal files
  if (fs.existsSync(signalDir)) {
    let files;
    try {
      files = fs.readdirSync(signalDir);
    } catch (err) {
      console.error('[session-signals] cleanupOldSignals readdir error:', err.message);
      files = [];
    }

    for (const filename of files) {
      if (!filename.endsWith('.json')) continue;
      const filePath = path.join(signalDir, filename);
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoffMs) {
          fs.unlinkSync(filePath);
          deletedFiles++;
        }
      } catch (err) {
        console.error(`[session-signals] Failed to delete signal file ${filename}:`, err.message);
        // Non-fatal
      }
    }
  }

  // Trim session-comms.log to last 24h
  if (fs.existsSync(logPath)) {
    try {
      const content = fs.readFileSync(logPath, 'utf8');
      const lines = content.split('\n').filter(l => l.trim());
      const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString();

      const kept = lines.filter(line => {
        try {
          const entry = JSON.parse(line);
          return entry.ts && entry.ts > cutoff;
        } catch (_) {
          return false;
        }
      });

      if (kept.length < lines.length) {
        const tmpPath = logPath + '.tmp';
        fs.writeFileSync(tmpPath, kept.join('\n') + (kept.length > 0 ? '\n' : ''));
        fs.renameSync(tmpPath, logPath);
        trimmedLog = true;
      }
    } catch (err) {
      console.error('[session-signals] cleanupOldSignals log trim error:', err.message);
      // Non-fatal
    }
  }

  return { deletedFiles, trimmedLog };
}
