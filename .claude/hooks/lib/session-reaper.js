/**
 * Session Reaper — Detects dead/stuck sessions in the queue and cleans them up.
 *
 * Two-pass design:
 *   reapSyncPass(db) — fast, synchronous; called from drainQueue()
 *   reapAsyncPass(projectDir, stuckAliveItems, options) — async; called from hourly-automation
 *
 * IMPORTANT: This module must NOT import session-queue.js (circular dep).
 * It receives the db instance as a parameter for sync operations and opens
 * its own connection for async operations.
 *
 * @module lib/session-reaper
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { auditEvent } from './session-audit.js';
import { getCooldown } from '../config-reader.js';

// Lazy-loaded SQLite
let Database = null;
try {
  Database = (await import('better-sqlite3')).default;
} catch (err) {
  console.error('[session-reaper] Warning:', err.message);
  // Non-fatal: async reaping and TODO reconciliation will be degraded
}

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// Session file constants
const HEAD_BYTES = 2000;
const TAIL_BYTES = 4000;
const TERMINAL_TOOL_BYTES = 16384;

// ============================================================================
// PID Utilities
// ============================================================================

/**
 * Check if a process is alive.
 * @param {number} pid
 * @returns {boolean}
 */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) { /* cleanup - failure expected */
    return false;
  }
}

/**
 * Check if a process is a zombie or stopped.
 * @param {number} pid
 * @returns {boolean}
 */
function isProcessZombieOrStopped(pid) {
  try {
    const state = execSync(`ps -o state= -p ${pid}`, {
      encoding: 'utf8',
      timeout: 3000,
      stdio: 'pipe',
    }).trim();
    return state === 'Z' || state === 'T';
  } catch (_) { /* cleanup - failure expected */
    return false; // Can't determine state — assume healthy
  }
}

/**
 * Kill a process with SIGTERM, wait, then SIGKILL if needed.
 * @param {number} pid
 * @returns {Promise<void>}
 */
async function killProcess(pid) {
  try { process.kill(pid, 'SIGTERM'); } catch (_) { /* cleanup - failure expected */ return; }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200));
    try { process.kill(pid, 0); } catch (_) { /* cleanup - failure expected */ return; } // Dead
  }
  try { process.kill(pid, 'SIGKILL'); } catch (_) { /* cleanup - failure expected */ /* already dead */ }
}

// ============================================================================
// Session File Utilities (local copies — avoids circular dep via revival-utils)
// ============================================================================

/**
 * Discover the session directory for a project.
 * @param {string} projectDir
 * @returns {string|null}
 */
function getSessionDir(projectDir) {
  const projectPath = projectDir.replace(/[^a-zA-Z0-9]/g, '-');
  const sessionDir = path.join(CLAUDE_PROJECTS_DIR, projectPath);
  if (fs.existsSync(sessionDir)) return sessionDir;

  const altPath = path.join(CLAUDE_PROJECTS_DIR, projectPath.replace(/^-/, ''));
  if (fs.existsSync(altPath)) return altPath;

  return null;
}

/**
 * Read the first N bytes of a file via fd seek.
 * @param {string} filePath
 * @param {number} numBytes
 * @returns {string}
 */
function readHead(filePath, numBytes) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(numBytes);
    const bytesRead = fs.readSync(fd, buf, 0, numBytes, 0);
    return buf.toString('utf8', 0, bytesRead);
  } catch (err) {
    console.error('[session-reaper] Warning:', err.message);
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Read the last N bytes of a file via fd seek.
 * @param {string} filePath
 * @param {number} numBytes
 * @returns {string}
 */
function readTail(filePath, numBytes) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const start = Math.max(0, stat.size - numBytes);
    const buf = Buffer.alloc(Math.min(numBytes, stat.size));
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8', 0, bytesRead);
  } catch (err) {
    console.error('[session-reaper] Warning:', err.message);
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Find session file by agent ID in a session directory.
 * @param {string} sessionDir
 * @param {string} agentId
 * @returns {string|null}
 */
function findSessionFileByAgentId(sessionDir, agentId) {
  const marker = `[AGENT:${agentId}]`;
  let files;
  try {
    files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'));
  } catch (err) {
    console.error('[session-reaper] Warning:', err.message);
    return null;
  }

  for (const file of files) {
    const filePath = path.join(sessionDir, file);
    const head = readHead(filePath, HEAD_BYTES);
    if (head.includes(marker)) return filePath;
  }

  return null;
}

/**
 * Check if a session's last assistant message indicates completion.
 * @param {string} sessionFile
 * @returns {boolean}
 */
function isSessionComplete(sessionFile) {
  const tail = readTail(sessionFile, TAIL_BYTES);
  if (!tail) return false;

  const lines = tail.split('\n').filter(l => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    let parsed;
    try { parsed = JSON.parse(lines[i]); } catch (err) {
      console.error('[session-reaper] Warning:', err.message);
      continue;
    }

    if (parsed.type !== 'assistant') return false;

    const content = parsed.message?.content;
    if (!Array.isArray(content)) return true;

    return !content.some(c => c.type === 'tool_use');
  }

  return false;
}

/**
 * Check if a session JSONL contains evidence of a terminal tool call
 * (complete_task or summarize_work) in the last 16KB.
 * @param {string} sessionFile
 * @returns {boolean}
 */
function sessionContainsTerminalTool(sessionFile) {
  const tail = readTail(sessionFile, TERMINAL_TOOL_BYTES);
  return tail.includes('"mcp__todo-db__complete_task"') ||
         tail.includes('"name":"complete_task"') ||
         tail.includes('"mcp__agent-tracker__summarize_work"') ||
         tail.includes('"name":"summarize_work"');
}

// ============================================================================
// Sync Pass — Called from drainQueue()
// ============================================================================

/**
 * Synchronous reaping pass: detect dead PIDs in running queue items.
 *
 * Called from drainQueue() — MUST be synchronous and fast.
 * Does NOT kill processes, trigger revival, or do JSONL analysis.
 *
 * @param {object} db - better-sqlite3 database instance (session-queue.db)
 * @returns {{ reaped: Array<{queueId: string, agentId: string, pid: number, revivalCandidate: boolean, metadata: object}>, stuckAlive: Array<{queueId: string, agentId: string, pid: number, spawnedAt: string, runDurationMs: number, agentType: string, title: string}> }}
 */
export function reapSyncPass(db) {
  const result = { reaped: [], stuckAlive: [] };
  const hardKillMs = getCooldown('session_hard_kill_minutes', 30) * 60 * 1000;
  const now = Date.now();

  // Only operate on 'running' items — 'suspended' items are intentionally paused
  // (preempted by CTO tasks) and must NOT be reaped. They have their own re-enqueue path.
  const running = db.prepare(
    "SELECT id, pid, agent_id, lane, spawn_type, spawned_at, agent_type, title, metadata FROM queue_items WHERE status = 'running'"
  ).all();

  for (const item of running) {
    // Gate lane exemption — gate agents are lightweight, handled separately
    if (item.lane === 'gate') continue;

    // Persistent lane exemption — long-running by design
    if (item.lane === 'persistent') continue;

    if (!item.pid) continue;

    if (!isPidAlive(item.pid)) {
      // Dead PID — mark completed
      db.prepare("UPDATE queue_items SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(item.id);

      let metadata = {};
      try { metadata = item.metadata ? JSON.parse(item.metadata) : {}; } catch (err) {
        // Metadata parse failed — log but continue
        try { process.stderr.write(`[session-reaper] metadata parse error for ${item.id}: ${err.message}\n`); } catch (err) {
          console.error('[session-reaper] Warning:', err.message);
        }
      }

      const revivalCandidate = !!(metadata.taskId && item.spawn_type === 'fresh');

      auditEvent('session_reaped_dead', {
        queue_id: item.id,
        agent_id: item.agent_id,
        pid: item.pid,
        agent_type: item.agent_type,
        revival_candidate: revivalCandidate,
      });

      result.reaped.push({
        queueId: item.id,
        agentId: item.agent_id,
        pid: item.pid,
        revivalCandidate,
        metadata,
      });
    } else if (item.spawned_at) {
      // PID alive — check if stuck (elapsed > hard kill threshold)
      const elapsed = now - new Date(item.spawned_at).getTime();
      if (elapsed > hardKillMs) {
        result.stuckAlive.push({
          queueId: item.id,
          agentId: item.agent_id,
          pid: item.pid,
          spawnedAt: item.spawned_at,
          runDurationMs: elapsed,
          agentType: item.agent_type,
          title: item.title,
        });
      }
    }
  }

  return result;
}

// ============================================================================
// Async Pass — Called from hourly-automation
// ============================================================================

/**
 * Asynchronous reaping pass: handle stuck-alive sessions via hard kill.
 *
 * For each stuck-alive item, performs multi-signal completion check:
 *   1. Session JSONL complete (no pending tool_use)
 *   2. Terminal tool called (complete_task or summarize_work)
 *   3. Process zombie/stopped state
 *
 * @param {string} projectDir - Project directory
 * @param {Array} stuckAliveItems - Items from getStuckAliveSessions()
 * @param {object} [options]
 * @param {function} [options.log] - Log function
 * @returns {Promise<{ completedReaped: number, hardKilled: number }>}
 */
export async function reapAsyncPass(projectDir, stuckAliveItems, options = {}) {
  const log = options.log || (() => {});
  const result = { completedReaped: 0, hardKilled: 0 };

  if (!Database) {
    log('Session reaper: better-sqlite3 not available, skipping async pass');
    return result;
  }

  const dbPath = path.join(projectDir, '.claude', 'state', 'session-queue.db');
  if (!fs.existsSync(dbPath)) return result;

  let db;
  try {
    db = new Database(dbPath);
    db.pragma('busy_timeout = 5000');
  } catch (err) {
    log(`Session reaper: cannot open queue DB: ${err.message}`);
    return result;
  }

  const sessionDir = getSessionDir(projectDir);

  try {
    for (const item of stuckAliveItems) {
      // Explicit safety guard: never reap suspended items (preempted by CTO tasks).
      // getStuckAliveSessions already filters for status='running', but double-check here.
      const currentStatus = db.prepare("SELECT status, lane FROM queue_items WHERE id = ?").get(item.queueId);
      if (currentStatus && currentStatus.status === 'suspended') {
        log(`Session reaper: skipping suspended item ${item.queueId} (preempted by CTO task)`);
        continue;
      }

      // Persistent lane exemption — long-running by design
      const effectiveLane = item.lane || (currentStatus && currentStatus.lane) || null;
      if (effectiveLane === 'persistent') {
        log(`Session reaper: skipping persistent item ${item.queueId} (long-running by design)`);
        continue;
      }

      // Find session file for JSONL analysis
      let sessionFile = null;
      if (sessionDir && item.agentId) {
        sessionFile = findSessionFileByAgentId(sessionDir, item.agentId);
      }

      // Multi-signal completion check
      const isComplete = sessionFile && isSessionComplete(sessionFile);
      const hasTerminalTool = sessionFile && sessionContainsTerminalTool(sessionFile);
      const isZombieOrStopped = isProcessZombieOrStopped(item.pid);

      if (isComplete || hasTerminalTool || isZombieOrStopped) {
        // Session finished but process lingered — graceful cleanup
        log(`Session reaper: reaping completed session ${item.agentId} (PID ${item.pid}, ${Math.round(item.runDurationMs / 60000)}min)`);
        await killProcess(item.pid);

        db.prepare("UPDATE queue_items SET status = 'completed', completed_at = datetime('now') WHERE id = ?")
          .run(item.queueId);

        auditEvent('session_reaped_complete', {
          queue_id: item.queueId,
          agent_id: item.agentId,
          pid: item.pid,
          run_duration_ms: item.runDurationMs,
          signals: { isComplete, hasTerminalTool, isZombieOrStopped },
        });

        // Reconcile TODO — mark completed if terminal tool was called
        if (hasTerminalTool) {
          reconcileTodo(item, projectDir, 'session_reaped_complete');
        }

        result.completedReaped++;
      } else {
        // Truly stuck — hard kill
        log(`Session reaper: HARD KILLING stuck session ${item.agentId} (PID ${item.pid}, ${Math.round(item.runDurationMs / 60000)}min, no completion signal)`);
        await killProcess(item.pid);

        db.prepare("UPDATE queue_items SET status = 'failed', error = 'hard_kill_timeout', completed_at = datetime('now') WHERE id = ?")
          .run(item.queueId);

        auditEvent('session_hard_killed', {
          queue_id: item.queueId,
          agent_id: item.agentId,
          pid: item.pid,
          run_duration_ms: item.runDurationMs,
          agent_type: item.agentType,
        });

        // Reset linked TODO to pending
        reconcileTodo(item, projectDir, 'session_hard_killed');

        // Write deputy-CTO report
        writeDeputyCtoReport(projectDir, item);

        result.hardKilled++;
      }
    }
  } catch (err) {
    log(`Session reaper async pass error: ${err.message}`);
  } finally {
    try { db.close(); } catch (_) { /* cleanup - failure expected */}
  }

  return result;
}

// ============================================================================
// Convenience Query — Called from hourly-automation
// ============================================================================

/**
 * Get running sessions that have exceeded the hard kill threshold.
 *
 * Opens its own DB connection (safe for async caller context).
 *
 * @returns {Array<{queueId: string, agentId: string, pid: number, spawnedAt: string, runDurationMs: number, agentType: string, title: string, lane: string, metadata: string}>}
 */
export function getStuckAliveSessions() {
  if (!Database) return [];

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const dbPath = path.join(projectDir, '.claude', 'state', 'session-queue.db');
  if (!fs.existsSync(dbPath)) return [];

  let db;
  try {
    db = new Database(dbPath, { readonly: true });
    db.pragma('busy_timeout = 5000');

    const hardKillMs = getCooldown('session_hard_kill_minutes', 30) * 60 * 1000;
    const cutoffTime = new Date(Date.now() - hardKillMs).toISOString();

    // Only query 'running' items — 'suspended' items must never be hard-killed
    // (they are intentionally preempted by CTO tasks and have a re-enqueue path)
    const items = db.prepare(
      "SELECT id, pid, agent_id, spawned_at, agent_type, title, lane, metadata FROM queue_items WHERE status = 'running' AND lane NOT IN ('gate', 'persistent') AND spawned_at < ?"
    ).all(cutoffTime);

    const now = Date.now();
    return items.filter(item => item.pid && isPidAlive(item.pid)).map(item => ({
      queueId: item.id,
      agentId: item.agent_id,
      pid: item.pid,
      spawnedAt: item.spawned_at,
      runDurationMs: now - new Date(item.spawned_at).getTime(),
      agentType: item.agent_type,
      title: item.title,
      lane: item.lane,
    }));
  } catch (err) {
    try { process.stderr.write(`[session-reaper] getStuckAliveSessions error: ${err.message}\n`); } catch (err) {
      console.error('[session-reaper] Warning:', err.message);
    }
    return [];
  } finally {
    if (db) try { db.close(); } catch (_) { /* cleanup - failure expected */}
  }
}

// ============================================================================
// TODO Reconciliation
// ============================================================================

/**
 * Reconcile a TODO item after reaping.
 *
 * @param {object} item - Queue item with metadata field (string or parsed)
 * @param {string} projectDir - Project directory
 * @param {string} reason - 'session_reaped_complete' or 'session_hard_killed'
 */
function reconcileTodo(item, projectDir, reason) {
  if (!Database) return;

  let metadata = item.metadata;
  if (typeof metadata === 'string') {
    try { metadata = JSON.parse(metadata); } catch (_) { /* cleanup - failure expected */ return; }
  }
  if (!metadata) return;

  const taskId = metadata.taskId;
  if (!taskId) return;

  const todoDbPath = path.join(projectDir, '.claude', 'todo.db');
  if (!fs.existsSync(todoDbPath)) return;

  let db;
  try {
    db = new Database(todoDbPath);

    const task = db.prepare('SELECT id, status FROM tasks WHERE id = ?').get(taskId);
    if (!task || task.status !== 'in_progress') return;

    if (reason === 'session_reaped_complete') {
      db.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run(taskId);
    } else if (reason === 'session_hard_killed') {
      db.prepare("UPDATE tasks SET status = 'pending', started_at = NULL, started_timestamp = NULL WHERE id = ?").run(taskId);
    }
  } catch (err) {
    try { process.stderr.write(`[session-reaper] reconcileTodo error: ${err.message}\n`); } catch (err) {
      console.error('[session-reaper] Warning:', err.message);
    }
  } finally {
    if (db) try { db.close(); } catch (_) { /* cleanup - failure expected */}
  }
}

// ============================================================================
// Deputy-CTO Report
// ============================================================================

/**
 * Write a deputy-CTO report for a hard-killed session.
 *
 * @param {string} projectDir - Project directory
 * @param {object} item - Stuck-alive queue item
 */
function writeDeputyCtoReport(projectDir, item) {
  if (!Database) return;

  const dbPath = path.join(projectDir, '.claude', 'cto-reports.db');
  if (!fs.existsSync(dbPath)) return;

  let db;
  try {
    db = new Database(dbPath);

    const idempotencyKey = `hard_kill_${item.queueId}`;

    // Check idempotency
    const existing = db.prepare('SELECT id FROM reports WHERE idempotency_key = ?').get(idempotencyKey);
    if (existing) return;

    const now = new Date();
    const id = `reaper-${item.queueId}`;

    db.prepare(`
      INSERT INTO reports (id, reporting_agent, title, summary, category, priority, created_at, created_timestamp, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      'session-reaper',
      `Hard-killed stuck session: ${item.title || item.agentId}`,
      `Session ${item.agentId} (PID ${item.pid}, queue ${item.queueId}) was hard-killed after ${Math.round(item.runDurationMs / 60000)}min with no completion signal. Agent type: ${item.agentType}. This may indicate a hung agent or infinite loop.`,
      'automation',
      'urgent',
      now.toISOString(),
      now.toISOString(),
      idempotencyKey,
    );
  } catch (err) {
    try { process.stderr.write(`[session-reaper] writeDeputyCtoReport error: ${err.message}\n`); } catch (err) {
      console.error('[session-reaper] Warning:', err.message);
    }
  } finally {
    if (db) try { db.close(); } catch (_) { /* cleanup - failure expected */}
  }
}
