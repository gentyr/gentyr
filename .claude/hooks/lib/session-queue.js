/**
 * Centralized Session Queue — SQLite-backed queue for ALL Claude agent spawning.
 *
 * Every spawner routes through enqueueSession(). The queue enforces a global
 * max-concurrent-sessions limit, priority ordering, and lane-based bypass.
 *
 * DB: .claude/state/session-queue.db (WAL mode)
 *
 * @module lib/session-queue
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import Database from 'better-sqlite3';
import { registerSpawn, updateAgent, AGENT_TYPES, HOOK_TYPES } from '../agent-tracker.js';
import { buildSpawnEnv } from './spawn-env.js';
import { shouldAllowSpawn } from './memory-pressure.js';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'session-queue.db');
const LOG_FILE = path.join(PROJECT_DIR, '.claude', 'session-queue.log');

// Lane sub-limits
const GATE_LANE_LIMIT = 5;

// Default TTL for queued items (30 minutes)
const DEFAULT_TTL_MS = 30 * 60 * 1000;

// ============================================================================
// Logging
// ============================================================================

function log(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [session-queue] ${message}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // Non-fatal
  }
}

// ============================================================================
// Database Initialization
// ============================================================================

let _db = null;

function getDb() {
  if (_db) return _db;

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('busy_timeout = 5000');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS queue_items (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'queued',
      priority TEXT NOT NULL DEFAULT 'normal',
      lane TEXT NOT NULL DEFAULT 'standard',

      spawn_type TEXT NOT NULL DEFAULT 'fresh',
      title TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      hook_type TEXT NOT NULL,
      tag_context TEXT NOT NULL,
      prompt TEXT,
      model TEXT,
      cwd TEXT,
      mcp_config TEXT,
      resume_session_id TEXT,
      extra_args TEXT,
      extra_env TEXT,
      project_dir TEXT NOT NULL,
      worktree_path TEXT,
      metadata TEXT,
      source TEXT NOT NULL,

      agent_id TEXT,
      pid INTEGER,
      enqueued_at TEXT NOT NULL DEFAULT (datetime('now')),
      spawned_at TEXT,
      completed_at TEXT,
      error TEXT,
      expires_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_queue_status ON queue_items(status);
    CREATE INDEX IF NOT EXISTS idx_queue_priority ON queue_items(priority, lane, enqueued_at);

    CREATE TABLE IF NOT EXISTS queue_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Seed default config if not present
  const existing = _db.prepare('SELECT value FROM queue_config WHERE key = ?').get('max_concurrent_sessions');
  if (!existing) {
    _db.prepare('INSERT INTO queue_config (key, value) VALUES (?, ?)').run('max_concurrent_sessions', '10');
  }

  return _db;
}

// ============================================================================
// ID Generation
// ============================================================================

function generateQueueId() {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(4).toString('hex');
  return `sq-${timestamp}-${random}`;
}

// ============================================================================
// Config Accessors
// ============================================================================

/**
 * Get the configured max concurrent sessions.
 * @returns {number}
 */
export function getMaxConcurrentSessions() {
  const db = getDb();
  const row = db.prepare('SELECT value FROM queue_config WHERE key = ?').get('max_concurrent_sessions');
  return row ? parseInt(row.value, 10) : 10;
}

/**
 * Set the max concurrent sessions.
 * @param {number} n - New limit (1-50)
 * @returns {{ old: number, new: number }}
 */
export function setMaxConcurrentSessions(n) {
  if (n < 1 || n > 50) throw new Error('max_concurrent_sessions must be between 1 and 50');
  const db = getDb();
  const old = getMaxConcurrentSessions();
  db.prepare('INSERT OR REPLACE INTO queue_config (key, value, updated_at) VALUES (?, ?, datetime(\'now\'))').run('max_concurrent_sessions', String(n));
  log(`Max concurrent sessions changed: ${old} -> ${n}`);
  return { old, new: n };
}

// ============================================================================
// PID Liveness Check
// ============================================================================

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Enqueue
// ============================================================================

/**
 * Enqueue a session for spawning.
 *
 * @param {object} spec
 * @param {string} spec.title - Human-readable title for CTO dashboard
 * @param {string} spec.agentType - Agent type from AGENT_TYPES
 * @param {string} spec.hookType - Hook type from HOOK_TYPES
 * @param {string} spec.tagContext - The [context] in [Task][context][AGENT:id]
 * @param {string} [spec.prompt] - Full prompt (built by caller or deferred to drain)
 * @param {string} [spec.model] - Model override (e.g., 'claude-haiku-4-5-20251001')
 * @param {string} [spec.cwd] - Working directory for the agent
 * @param {string} [spec.mcpConfig] - Path to .mcp.json
 * @param {string} [spec.resumeSessionId] - For --resume spawns
 * @param {string} [spec.spawnType='fresh'] - 'fresh' or 'resume'
 * @param {string} [spec.priority='normal'] - 'critical'|'urgent'|'normal'|'low'
 * @param {string} [spec.lane='standard'] - 'revival'|'gate'|'standard'
 * @param {string[]} [spec.extraArgs] - Additional CLI args
 * @param {object} [spec.extraEnv] - Additional env vars
 * @param {string} [spec.projectDir] - Project directory
 * @param {string} [spec.worktreePath] - Worktree path if applicable
 * @param {object} [spec.metadata] - Additional metadata (taskId, section, etc.)
 * @param {string} spec.source - Which spawner enqueued this (e.g., 'task-gate-spawner')
 * @param {number} [spec.ttlMs] - TTL in ms (default 30 min)
 * @param {function} [spec.buildPrompt] - Deferred prompt builder: (agentId) => string
 * @returns {{ queueId: string, position: number, drained: object }}
 */
export function enqueueSession(spec) {
  // Validate required fields
  if (!spec.title) throw new Error('enqueueSession: title is required');
  if (!spec.agentType) throw new Error('enqueueSession: agentType is required');
  if (!spec.hookType) throw new Error('enqueueSession: hookType is required');
  if (!spec.tagContext) throw new Error('enqueueSession: tagContext is required');
  if (!spec.source) throw new Error('enqueueSession: source is required');

  // Validate tagContext format (hyphenated identifier)
  if (!/^[a-z0-9][a-z0-9-]*$/.test(spec.tagContext)) {
    throw new Error(`enqueueSession: tagContext must be a hyphenated lowercase identifier, got: "${spec.tagContext}"`);
  }

  const db = getDb();
  const id = generateQueueId();
  const projectDir = spec.projectDir || PROJECT_DIR;
  const ttlMs = spec.ttlMs || DEFAULT_TTL_MS;
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  // Eagerly build the prompt at enqueue time using {AGENT_ID} as a placeholder.
  // This ensures the prompt survives cross-process drains where the in-memory
  // buildPrompt callback would be lost. The placeholder is substituted with the
  // real agentId at spawn time in spawnQueueItem().
  let prompt = spec.prompt || null;
  if (spec.buildPrompt) {
    prompt = spec.buildPrompt('{AGENT_ID}');
  }

  db.prepare(`
    INSERT INTO queue_items (id, status, priority, lane, spawn_type, title, agent_type, hook_type,
      tag_context, prompt, model, cwd, mcp_config, resume_session_id, extra_args, extra_env,
      project_dir, worktree_path, metadata, source, expires_at)
    VALUES (?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    spec.priority || 'normal',
    spec.lane || 'standard',
    spec.spawnType || 'fresh',
    spec.title,
    spec.agentType,
    spec.hookType,
    spec.tagContext,
    prompt,
    spec.model || null,
    spec.cwd || null,
    spec.mcpConfig || null,
    spec.resumeSessionId || null,
    spec.extraArgs ? JSON.stringify(spec.extraArgs) : null,
    spec.extraEnv ? JSON.stringify(spec.extraEnv) : null,
    projectDir,
    spec.worktreePath || null,
    spec.metadata ? JSON.stringify(spec.metadata) : null,
    spec.source,
    expiresAt,
  );

  const position = db.prepare("SELECT COUNT(*) as cnt FROM queue_items WHERE status = 'queued'").get().cnt;
  log(`Enqueued ${id}: "${spec.title}" (priority=${spec.priority || 'normal'}, lane=${spec.lane || 'standard'}, source=${spec.source}, position=${position})`);

  // Inline drain — try to spawn immediately if slots available
  const drained = drainQueue();

  return { queueId: id, position, drained };
}

// ============================================================================
// Drain Queue
// ============================================================================

/**
 * Process the queue: spawn queued items up to capacity.
 *
 * @returns {{ spawned: number, queued: number, atCapacity: boolean, failed: number }}
 */
export function drainQueue() {
  const db = getDb();
  const result = { spawned: 0, queued: 0, atCapacity: false, failed: 0 };

  // Step 1: Clean stale running items (PID dead → mark completed)
  const running = db.prepare("SELECT id, pid, agent_id FROM queue_items WHERE status = 'running'").all();
  for (const item of running) {
    if (item.pid && !isPidAlive(item.pid)) {
      db.prepare("UPDATE queue_items SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(item.id);
      log(`Reaped stale running item ${item.id} (PID ${item.pid} dead)`);
    }
  }

  // Step 2: Expire old queued items past TTL
  db.prepare("UPDATE queue_items SET status = 'cancelled', error = 'TTL expired' WHERE status = 'queued' AND expires_at < datetime('now')").run();

  // Step 3: Count running items by lane
  const standardRunning = db.prepare("SELECT COUNT(*) as cnt FROM queue_items WHERE status = 'running' AND lane != 'gate'").get().cnt;
  const gateRunning = db.prepare("SELECT COUNT(*) as cnt FROM queue_items WHERE status = 'running' AND lane = 'gate'").get().cnt;
  const maxConcurrent = getMaxConcurrentSessions();

  // Step 4: Get queued items ordered by priority then enqueue time
  // Revival lane items first, then gate, then standard
  const queued = db.prepare(`
    SELECT * FROM queue_items WHERE status = 'queued'
    ORDER BY
      CASE lane WHEN 'revival' THEN 0 WHEN 'gate' THEN 1 ELSE 2 END,
      CASE priority WHEN 'critical' THEN 0 WHEN 'urgent' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
      enqueued_at ASC
  `).all();

  result.queued = queued.length;

  // Track spawns per lane this drain cycle to avoid stale counter bugs
  let standardSpawnedThisDrain = 0;
  let gateSpawnedThisDrain = 0;

  for (const item of queued) {
    // Gate lane has its own sub-limit (tracked separately from main capacity)
    if (item.lane === 'gate') {
      if (gateRunning + gateSpawnedThisDrain >= GATE_LANE_LIMIT) {
        continue; // Skip, gate full
      }
    } else {
      // Standard + revival lanes share the main limit (gate spawns don't consume it)
      if (standardRunning + standardSpawnedThisDrain >= maxConcurrent) {
        result.atCapacity = true;
        break;
      }
    }

    // Memory pressure check
    const memCheck = shouldAllowSpawn({
      priority: item.priority,
      context: `session-queue:${item.source}`,
    });
    if (!memCheck.allowed) {
      log(`Memory pressure blocked ${item.id}: ${memCheck.reason}`);
      continue; // Skip this item, try next (might be higher priority)
    }

    // Attempt to spawn
    try {
      spawnQueueItem(db, item);
      result.spawned++;
      if (item.lane === 'gate') {
        gateSpawnedThisDrain++;
      } else {
        standardSpawnedThisDrain++;
      }
    } catch (err) {
      db.prepare("UPDATE queue_items SET status = 'failed', error = ?, completed_at = datetime('now') WHERE id = ?")
        .run(err.message, item.id);
      log(`Failed to spawn ${item.id}: ${err.message}`);
      result.failed++;
    }
  }

  if (result.spawned > 0) {
    log(`Drain complete: spawned=${result.spawned}, remaining=${result.queued - result.spawned}, atCapacity=${result.atCapacity}`);
  }

  return result;
}

/**
 * Spawn a single queue item.
 * @param {Database} db
 * @param {object} item - Queue item row
 */
function spawnQueueItem(db, item) {
  // Atomic claim: mark as spawning only if still queued.
  // If another concurrent drain already claimed this item, changes === 0.
  const claimResult = db.prepare("UPDATE queue_items SET status = 'spawning' WHERE id = ? AND status = 'queued'").run(item.id);
  if (claimResult.changes === 0) {
    throw new Error(`Item ${item.id} already claimed by concurrent drain`);
  }

  // Register with agent-tracker
  const agentId = registerSpawn({
    type: item.agent_type,
    hookType: item.hook_type,
    description: item.title,
    prompt: '',
    projectDir: item.worktree_path || item.project_dir,
    metadata: item.metadata ? JSON.parse(item.metadata) : {},
  });

  // Replace {AGENT_ID} placeholder in the stored prompt (eagerly built at enqueue time)
  let prompt;
  if (item.prompt) {
    prompt = item.prompt.replace(/\{AGENT_ID\}/g, agentId);
  } else {
    prompt = `[Task][${item.tag_context}][AGENT:${agentId}] ${item.title}`;
  }

  // Ensure the prompt has the standard tag prefix
  if (!prompt.startsWith('[Task]')) {
    prompt = `[Task][${item.tag_context}][AGENT:${agentId}] ${prompt}`;
  }

  // Update agent-tracker with final prompt
  updateAgent(agentId, { prompt });

  // Build spawn args
  const spawnArgs = [];
  if (item.spawn_type === 'resume' && item.resume_session_id) {
    spawnArgs.push('--resume', item.resume_session_id);
  }
  spawnArgs.push('--dangerously-skip-permissions');
  if (item.model) {
    spawnArgs.push('--model', item.model);
  }
  const mcpConfig = item.mcp_config || path.join(item.worktree_path || item.project_dir, '.mcp.json');
  spawnArgs.push('--mcp-config', mcpConfig);
  spawnArgs.push('--output-format', 'json');

  // Parse extra args
  if (item.extra_args) {
    const extraArgs = JSON.parse(item.extra_args);
    spawnArgs.push(...extraArgs);
  }

  spawnArgs.push('-p', prompt);

  // Build environment
  const extraEnv = item.extra_env ? JSON.parse(item.extra_env) : {};
  const spawnEnv = buildSpawnEnv(agentId, {
    projectDir: item.project_dir,
    extraEnv,
  });

  // Spawn
  const effectiveCwd = item.cwd || item.worktree_path || item.project_dir;
  const claude = spawn('claude', spawnArgs, {
    detached: true,
    stdio: 'ignore',
    cwd: effectiveCwd,
    env: spawnEnv,
  });

  claude.unref();

  if (!claude.pid) {
    throw new Error('spawn returned no PID');
  }

  // Update DB and agent-tracker
  db.prepare("UPDATE queue_items SET status = 'running', agent_id = ?, pid = ?, spawned_at = datetime('now') WHERE id = ?")
    .run(agentId, claude.pid, item.id);
  updateAgent(agentId, { pid: claude.pid, status: 'running' });

  log(`Spawned ${item.id} as agent ${agentId} (PID ${claude.pid}): "${item.title}"`);
}

// ============================================================================
// Cancel
// ============================================================================

/**
 * Cancel a queued item.
 * @param {string} queueId
 * @returns {{ success: boolean, reason?: string }}
 */
export function cancelQueueItem(queueId) {
  const db = getDb();
  const item = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(queueId);
  if (!item) return { success: false, reason: 'not found' };
  if (item.status !== 'queued') return { success: false, reason: `cannot cancel item in status: ${item.status}` };

  db.prepare("UPDATE queue_items SET status = 'cancelled', completed_at = datetime('now'), error = 'manually cancelled' WHERE id = ?").run(queueId);
  log(`Cancelled ${queueId}`);
  return { success: true };
}

// ============================================================================
// Mark Completed
// ============================================================================

/**
 * Mark a running item as completed by agent ID.
 * @param {string} agentId
 * @returns {boolean}
 */
export function markCompleted(agentId) {
  const db = getDb();
  const result = db.prepare("UPDATE queue_items SET status = 'completed', completed_at = datetime('now') WHERE agent_id = ? AND status = 'running'").run(agentId);
  if (result.changes > 0) {
    log(`Marked completed: agent ${agentId}`);
    return true;
  }
  return false;
}

// ============================================================================
// Queue Status (for CTO Dashboard)
// ============================================================================

/**
 * Get full queue status for dashboard rendering.
 * @returns {object}
 */
export function getQueueStatus() {
  const db = getDb();
  const maxConcurrent = getMaxConcurrentSessions();

  // Reap stale running items first
  const runningItems = db.prepare("SELECT * FROM queue_items WHERE status = 'running' ORDER BY spawned_at ASC").all();
  for (const item of runningItems) {
    if (item.pid && !isPidAlive(item.pid)) {
      db.prepare("UPDATE queue_items SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(item.id);
    }
  }

  // Re-query after reaping
  const activeRunning = db.prepare("SELECT * FROM queue_items WHERE status = 'running' ORDER BY spawned_at ASC").all();
  const queuedItems = db.prepare("SELECT * FROM queue_items WHERE status = 'queued' ORDER BY enqueued_at ASC").all();

  // 24h stats
  const completed24h = db.prepare("SELECT COUNT(*) as cnt FROM queue_items WHERE status IN ('completed', 'failed') AND completed_at > datetime('now', '-24 hours')").get().cnt;
  const avgWait = db.prepare("SELECT AVG(CAST((julianday(spawned_at) - julianday(enqueued_at)) * 86400 AS INTEGER)) as avg_secs FROM queue_items WHERE spawned_at IS NOT NULL AND enqueued_at IS NOT NULL AND spawned_at > datetime('now', '-24 hours')").get();
  const avgRun = db.prepare("SELECT AVG(CAST((julianday(completed_at) - julianday(spawned_at)) * 86400 AS INTEGER)) as avg_secs FROM queue_items WHERE completed_at IS NOT NULL AND spawned_at IS NOT NULL AND completed_at > datetime('now', '-24 hours')").get();
  const bySource = db.prepare("SELECT source, COUNT(*) as cnt FROM queue_items WHERE enqueued_at > datetime('now', '-24 hours') GROUP BY source ORDER BY cnt DESC LIMIT 10").all();

  const now = Date.now();

  return {
    hasData: true,
    maxConcurrent,
    running: activeRunning.length,
    availableSlots: Math.max(0, maxConcurrent - activeRunning.length),
    queuedItems: queuedItems.map(item => ({
      id: item.id,
      title: item.title,
      priority: item.priority,
      lane: item.lane,
      source: item.source,
      waitTime: formatElapsed(now - new Date(item.enqueued_at).getTime()),
    })),
    runningItems: activeRunning.map(item => ({
      id: item.id,
      title: item.title,
      source: item.source,
      agentType: item.agent_type,
      agentId: item.agent_id,
      pid: item.pid,
      elapsed: item.spawned_at ? formatElapsed(now - new Date(item.spawned_at).getTime()) : 'unknown',
    })),
    stats: {
      completedLast24h: completed24h,
      avgWaitSeconds: Math.round(avgWait?.avg_secs || 0),
      avgRunSeconds: Math.round(avgRun?.avg_secs || 0),
      bySource: Object.fromEntries(bySource.map(r => [r.source, r.cnt])),
    },
  };
}

/**
 * Format milliseconds as human-readable elapsed time.
 * @param {number} ms
 * @returns {string}
 */
function formatElapsed(ms) {
  if (ms < 0) return '0s';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return `${hours}h${remainMins > 0 ? ` ${remainMins}m` : ''}`;
}
