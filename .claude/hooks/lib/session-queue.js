/**
 * Centralized Session Queue — SQLite-backed queue for ALL Claude agent spawning.
 *
 * Every spawner routes through enqueueSession(). The queue enforces a global
 * max-concurrent-sessions limit, priority ordering, and lane-based bypass.
 *
 * DB: .claude/state/session-queue.db (WAL mode)
 *
 * Priority levels (highest to lowest): cto > critical > urgent > normal > low
 * Status values: queued, spawning, running, suspended, completed, failed, cancelled
 *
 * @module lib/session-queue
 * @version 1.1.0
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn } from 'child_process';
import Database from 'better-sqlite3';
import { registerSpawn, updateAgent, AGENT_TYPES, HOOK_TYPES } from '../agent-tracker.js';
import { buildSpawnEnv } from './spawn-env.js';
import { shouldAllowSpawn } from './memory-pressure.js';
import { reapSyncPass, diagnoseSessionFailure } from './session-reaper.js';
import { getCooldown } from '../config-reader.js';
import { killProcessGroup, isClaudeProcess } from './process-tree.js';
import { auditEvent } from './session-audit.js';
import { debugLog } from './debug-log.js';
import { buildPersistentMonitorDemoInstructions } from './persistent-monitor-demo-instructions.js';
import { buildPersistentMonitorStrictInfraInstructions } from './persistent-monitor-strict-infra-instructions.js';
import { checkAndExpireResources } from './resource-lock.js';
import { cleanupStaleAllocations as cleanupStalePortAllocations } from './port-allocator.js';
import { buildRevivalContext } from './persistent-revival-context.js';
import { checkBypassBlock, getBypassResolutionContext } from './bypass-guard.js';

// Self-healing module — loaded eagerly but non-fatal if missing
let _handleBlocker = null;
try {
  const mod = await import('./blocker-auto-heal.js');
  _handleBlocker = mod.handleBlocker;
} catch (_) { /* non-fatal — self-healing unavailable */ }
import { isLocalModeEnabled } from '../../../lib/shared-mcp-config.js';
// NOTE: revival-utils.js imports from session-queue.js (circular dep), so we
// inline these three utilities here instead of importing from revival-utils.js.
// Mirrors the same pattern used in session-reaper.js.

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'session-queue.db');
const LOG_FILE = path.join(PROJECT_DIR, '.claude', 'session-queue.log');
const FOCUS_MODE_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'focus-mode.json');

// Lane sub-limits
const GATE_LANE_LIMIT = 5;
const AUDIT_LANE_LIMIT = 5;

/**
 * Parse a SQLite datetime string as UTC.
 * SQLite's datetime('now') produces "YYYY-MM-DD HH:MM:SS" (UTC, no Z suffix).
 * JavaScript's new Date() parses this as local time without timezone indicator.
 * This helper ensures correct UTC interpretation.
 */
function parseSqliteDatetime(str) {
  if (!str) return new Date(NaN);
  if (str.includes('T')) return new Date(str); // Already ISO 8601
  return new Date(str.replace(' ', 'T') + 'Z');
}
// Persistent lane has no limit — monitors always spawn immediately and are auto-revived on death.

// Default TTL for queued items (30 minutes)
const DEFAULT_TTL_MS = 30 * 60 * 1000;

// In-memory rate limiter for persistent monitor revivals (immune to WAL visibility issues)
const _monitorRevivalTimestamps = new Map(); // taskId -> {ts: number, reason: string}[]

// ============================================================================
// Logging
// ============================================================================

function log(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [session-queue] ${message}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // Non-fatal — log file not writable, nothing we can do
  }
}

// ============================================================================
// Session File Utilities (inline — avoids circular dep via revival-utils.js)
// ============================================================================

const CLAUDE_PROJECTS_DIR_SQ = path.join(os.homedir(), '.claude', 'projects');

/**
 * Discover the session directory for a project.
 * @param {string} projectDir
 * @returns {string|null}
 */
function getSessionDir(projectDir) {
  const projectPath = projectDir.replace(/[^a-zA-Z0-9]/g, '-');
  const sessionDir = path.join(CLAUDE_PROJECTS_DIR_SQ, projectPath);
  if (fs.existsSync(sessionDir)) return sessionDir;

  const altPath = path.join(CLAUDE_PROJECTS_DIR_SQ, projectPath.replace(/^-/, ''));
  if (fs.existsSync(altPath)) return altPath;

  return null;
}

/**
 * Find a session JSONL file by agent ID in the session directory.
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
    log(`Warning: ${err.message}`);
    return null;
  }

  for (const file of files) {
    const filePath = path.join(sessionDir, file);
    let fd;
    try {
      fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(2000);
      const bytesRead = fs.readSync(fd, buf, 0, 2000, 0);
      const head = buf.toString('utf8', 0, bytesRead);
      if (head.includes(marker)) return filePath;
    } catch (err) {
      log(`Warning: ${err.message}`);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  return null;
}

/**
 * Extract session ID from a JSONL transcript path.
 * @param {string} transcriptPath
 * @returns {string|null}
 */
function extractSessionIdFromPath(transcriptPath) {
  if (!transcriptPath) return null;
  const basename = path.basename(transcriptPath, '.jsonl');
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  return uuidRegex.test(basename) ? basename : null;
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
      agent TEXT,

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
    CREATE INDEX IF NOT EXISTS idx_queue_worktree ON queue_items(worktree_path) WHERE worktree_path IS NOT NULL;

    CREATE TABLE IF NOT EXISTS queue_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS revival_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_revival_task_time ON revival_events(task_id, created_at);
  `);

  // Idempotent migration: add agent column for existing DBs
  try {
    _db.prepare('SELECT agent FROM queue_items LIMIT 0').get();
  } catch {
    _db.exec('ALTER TABLE queue_items ADD COLUMN agent TEXT');
  }

  // Idempotent migration: add diagnosis column to revival_events
  try {
    _db.prepare('SELECT diagnosis FROM revival_events LIMIT 0').get();
  } catch {
    _db.exec('ALTER TABLE revival_events ADD COLUMN diagnosis TEXT');
  }

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
// Focus Mode
// ============================================================================

/**
 * Check whether focus mode is currently enabled.
 * Reads from disk synchronously; returns false on any error.
 * @returns {boolean}
 */
export function isFocusModeEnabled() {
  try {
    if (!fs.existsSync(FOCUS_MODE_PATH)) return false;
    const state = JSON.parse(fs.readFileSync(FOCUS_MODE_PATH, 'utf8'));
    return state.enabled === true;
  } catch (_) {
    return false;
  }
}

/**
 * Enable or disable focus mode.
 * Writes state to disk and emits an audit event.
 * @param {boolean} enabled
 * @param {string} [enabledBy='cto']
 * @returns {{ enabled: boolean, enabledAt: string, enabledBy: string }}
 */
export function setFocusMode(enabled, enabledBy = 'cto') {
  const state = { enabled, enabledAt: new Date().toISOString(), enabledBy };
  const dir = path.dirname(FOCUS_MODE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(FOCUS_MODE_PATH, JSON.stringify(state, null, 2));
  log(`Focus mode ${enabled ? 'ENABLED' : 'DISABLED'} by ${enabledBy}`);
  auditEvent(enabled ? 'focus_mode_enabled' : 'focus_mode_disabled', { enabledBy });
  return state;
}

/**
 * Get the number of slots reserved for priority-eligible tasks (persistent/CTO/critical).
 * @returns {number}
 */
export function getReservedSlots() {
  const db = getDb();
  const row = db.prepare('SELECT value FROM queue_config WHERE key = ?').get('reserved_slots');
  return row ? parseInt(row.value, 10) : 0; // Default 0 — no reservation until activated
}

/**
 * Set the number of reserved slots.
 * @param {number} n - Number of slots to reserve (0-10)
 * @param {object} [opts]
 * @param {number} [opts.autoRestoreMinutes] - Auto-restore to defaultValue after N minutes
 * @param {number} [opts.defaultValue=0] - Value to restore to (default: 0)
 * @returns {{ old: number, new: number }}
 */
export function setReservedSlots(n, opts = {}) {
  if (n < 0 || n > 10) throw new Error('reserved_slots must be between 0 and 10');
  const db = getDb();
  const old = getReservedSlots();
  db.prepare("INSERT OR REPLACE INTO queue_config (key, value, updated_at) VALUES (?, ?, datetime('now'))")
    .run('reserved_slots', String(n));

  // Schedule auto-restore if requested
  if (opts.autoRestoreMinutes) {
    const restoreAt = new Date(Date.now() + opts.autoRestoreMinutes * 60000).toISOString();
    const defaultVal = opts.defaultValue ?? 0;
    db.prepare("INSERT OR REPLACE INTO queue_config (key, value, updated_at) VALUES (?, ?, datetime('now'))")
      .run('reserved_slots_restore', JSON.stringify({ restoreAt, defaultValue: defaultVal }));
  }

  log(`Reserved slots changed: ${old} -> ${n}`);
  return { old, new: n };
}

// ============================================================================
// PID Liveness Check
// ============================================================================

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) { /* cleanup - failure expected */
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
 * @param {string} spec.tagContext - The [context] in [Automation][context][AGENT:id]
 * @param {string} [spec.prompt] - Full prompt (built by caller or deferred to drain)
 * @param {string} [spec.model] - Model override (e.g., 'claude-haiku-4-5-20251001')
 * @param {string} [spec.cwd] - Working directory for the agent
 * @param {string} [spec.mcpConfig] - Path to .mcp.json
 * @param {string} [spec.resumeSessionId] - For --resume spawns
 * @param {string} [spec.spawnType='fresh'] - 'fresh' or 'resume'
 * @param {string} [spec.priority='normal'] - 'cto'|'critical'|'urgent'|'normal'|'low'
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

  // Normalize worktree/cwd paths (strip trailing slashes for consistent comparison)
  if (spec.worktreePath) spec.worktreePath = spec.worktreePath.replace(/\/+$/, '');
  if (spec.cwd) spec.cwd = spec.cwd.replace(/\/+$/, '');

  const db = getDb();

  // Dedup: if this task is already queued or running, return the existing queue item
  if (spec.metadata?.taskId) {
    const existing = db.prepare(
      "SELECT id FROM queue_items WHERE status IN ('queued', 'running', 'spawning') AND json_extract(metadata, '$.taskId') = ?"
    ).get(spec.metadata.taskId);
    if (existing) {
      log(`Dedup: task ${spec.metadata.taskId} already has queue item ${existing.id} — skipping`);
      return { queueId: existing.id, position: 0, drained: { spawned: 0, atCapacity: false } };
    }
  }

  // Dedup: if this persistent task already has a queued/running monitor, skip
  if (spec.metadata?.persistentTaskId && spec.lane === 'persistent') {
    const existing = db.prepare(
      "SELECT id FROM queue_items WHERE lane = 'persistent' AND status IN ('queued', 'running', 'spawning') AND json_extract(metadata, '$.persistentTaskId') = ?"
    ).get(spec.metadata.persistentTaskId);
    if (existing) {
      log(`Dedup: persistentTaskId ${spec.metadata.persistentTaskId} already has queue item ${existing.id} — skipping`);
      return { queueId: existing.id, position: 0, drained: { spawned: 0, atCapacity: false } };
    }
  }

  // Plan-level dedup: if this item serves a plan, block if ANY monitor for the same plan
  // is already queued/running (regardless of persistentTaskId). Prevents mass-spawning
  // when multiple persistent tasks exist for the same plan (e.g., from prior reviveOrphanedPlan proliferation).
  if (spec.metadata?.planId && spec.lane === 'persistent') {
    const planExisting = db.prepare(
      "SELECT id FROM queue_items WHERE lane = 'persistent' AND status IN ('queued', 'running', 'spawning') AND json_extract(metadata, '$.planId') = ?"
    ).get(spec.metadata.planId);
    if (planExisting) {
      log(`Dedup: planId ${spec.metadata.planId} already has queue item ${planExisting.id} — skipping`);
      return { queueId: planExisting.id, position: 0, drained: { spawned: 0, atCapacity: false } };
    }
  }

  // Worktree exclusivity: block if another session is already using this worktree path.
  // Two separate queue items must NEVER share the same worktree — sub-agents within a
  // single session share the parent's CWD (no queue entry), which is fine, but separate
  // queue items operating on the same worktree leads to Bug #6 (worktree destruction).
  if (spec.worktreePath || spec.cwd) {
    const wtCheckPath = spec.worktreePath || spec.cwd;
    const wtExisting = db.prepare(
      "SELECT id, title, status FROM queue_items WHERE status IN ('queued', 'running', 'spawning', 'suspended') AND (worktree_path = ? OR cwd = ?)"
    ).get(wtCheckPath, wtCheckPath);
    if (wtExisting) {
      log(`Worktree exclusivity BLOCKED: "${spec.title}" — worktree ${wtCheckPath} already in use by queue item ${wtExisting.id} ("${wtExisting.title}", status: ${wtExisting.status})`);
      return { queueId: null, blocked: 'worktree_exclusive', title: spec.title, conflictQueueId: wtExisting.id, conflictTitle: wtExisting.title };
    }
  }

  // Bypass request gate: block spawns for tasks with pending CTO bypass requests
  // Source 'bypass-request-resolve' is exempt — it's the CTO approving the request
  if (spec.source !== 'bypass-request-resolve') {
    const bypassTaskId = spec.metadata?.persistentTaskId || spec.metadata?.taskId;
    const bypassTaskType = spec.metadata?.persistentTaskId ? 'persistent' : (spec.metadata?.taskId ? 'todo' : null);
    if (bypassTaskType && bypassTaskId) {
      const bypassCheck = checkBypassBlock(bypassTaskType, bypassTaskId);
      if (bypassCheck.blocked) {
        log(`Bypass request BLOCKED: "${spec.title}" — pending CTO bypass request ${bypassCheck.requestId} (${bypassCheck.category})`);
        return { queueId: null, blocked: 'bypass_request', title: spec.title, bypassRequestId: bypassCheck.requestId };
      }
    }
  }

  // Focus mode gate: block non-CTO automated spawns
  if (isFocusModeEnabled()) {
    const allowed =
      spec.priority === 'cto' || spec.priority === 'critical' ||
      spec.lane === 'persistent' || spec.lane === 'gate' || spec.lane === 'audit' || spec.lane === 'revival' ||
      spec.source === 'force-spawn-tasks' ||
      spec.source === 'persistent-task-spawner' ||
      spec.source === 'stop-continue-hook' ||
      spec.source === 'session-queue-reaper' ||
      spec.source === 'sync-recycle' ||
      (spec.metadata && spec.metadata.persistentTaskId);

    if (!allowed) {
      log(`Focus mode BLOCKED: "${spec.title}" (source: ${spec.source}, priority: ${spec.priority || 'normal'})`);
      return { queueId: null, blocked: 'focus_mode', title: spec.title };
    }
  }

  const id = generateQueueId();
  const projectDir = spec.projectDir || PROJECT_DIR;
  const ttlMs = spec.ttlMs ?? DEFAULT_TTL_MS;
  const expiresAt = ttlMs === 0 ? null : new Date(Date.now() + ttlMs).toISOString();

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
      project_dir, worktree_path, metadata, source, agent, expires_at)
    VALUES (?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    spec.agent || null,
    expiresAt,
  );

  const position = db.prepare("SELECT COUNT(*) as cnt FROM queue_items WHERE status = 'queued'").get().cnt;
  log(`Enqueued ${id}: "${spec.title}" (priority=${spec.priority || 'normal'}, lane=${spec.lane || 'standard'}, source=${spec.source}, position=${position})`);

  auditEvent('session_enqueued', {
    queue_id: id,
    source: spec.source,
    agent_type: spec.agentType,
    priority: spec.priority || 'normal',
    lane: spec.lane || 'standard',
    title: spec.title,
  });

  debugLog('session-queue', 'enqueue', { queueId: id, title: spec.title, priority: spec.priority || 'normal', lane: spec.lane || 'standard', source: spec.source });

  // Inline drain — try to spawn immediately if slots available
  const drained = drainQueue();

  return { queueId: id, position, drained };
}

// ============================================================================
// Persistent Monitor Immediate Revival
// ============================================================================

/**
 * Check if a dead session was killed by an API rate limit (not a real crash).
 * Reads the tail of the session's JSONL and looks for rate-limit error patterns.
 * Returns the parsed reset time string if found, null otherwise.
 *
 * @param {object} db - session-queue.db instance
 * @param {string} taskId - persistent task ID
 * @returns {{ rateLimited: boolean; resetInfo?: string }}
 */
function detectRateLimitDeath(db, taskId) {
  try {
    // Find the most recent queue item for this task to get the agent ID
    const recentItem = db.prepare(
      "SELECT agent_id FROM queue_items WHERE json_extract(metadata, '$.persistentTaskId') = ? ORDER BY completed_at DESC, spawned_at DESC LIMIT 1"
    ).get(taskId);
    if (!recentItem?.agent_id) return { rateLimited: false };

    // Find the session JSONL file
    const sessionDir = resolveSessionDir();
    if (!sessionDir) return { rateLimited: false };
    const sessionFile = findSessionFileByAgentId(sessionDir, recentItem.agent_id);
    if (!sessionFile) return { rateLimited: false };

    // Read last 4KB of the session file
    let fd;
    try {
      fd = fs.openSync(sessionFile, 'r');
      const stat = fs.fstatSync(fd);
      const start = Math.max(0, stat.size - 4096);
      const buf = Buffer.alloc(Math.min(4096, stat.size));
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, start);
      const tail = buf.toString('utf8', 0, bytesRead);

      // Look for rate-limit patterns in the tail
      const rateLimitPatterns = [
        /you've hit your limit/i,
        /you're out of extra usage/i,
        /usage limit.*reset/i,
        /rate limit exceeded/i,
      ];
      const resetPattern = /resets?\s+(\d{1,2}:\d{2}\s*(?:am|pm)?(?:\s*\([^)]+\))?)/i;

      const lines = tail.split('\n').filter(l => l.trim());
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 10); i--) {
        const line = lines[i];
        if (rateLimitPatterns.some(p => p.test(line))) {
          const resetMatch = line.match(resetPattern);
          return {
            rateLimited: true,
            resetInfo: resetMatch ? resetMatch[1].trim() : 'unknown',
          };
        }
      }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  } catch (_) { /* non-fatal — treat as not rate-limited */ }
  return { rateLimited: false };
}

/**
 * Re-enqueue a dead persistent monitor directly into the queue DB.
 * Called from drainQueue after reapSyncPass detects a dead persistent PID.
 * Uses direct INSERT (not enqueueSession) to avoid recursive drain.
 *
 * Rate-limit awareness: if the session died due to an API usage limit,
 * skip the crash-loop counter (not a real crash) and set a 15-minute
 * cooldown before retrying.
 *
 * @param {object} db - session-queue.db instance (already open)
 * @param {string} taskId - persistent task ID
 */
function requeueDeadPersistentMonitor(db, taskId, reapReason = 'unknown', diagnosis = null) {
  // Rate limit detection: use structured diagnosis if available, fall back to existing detection
  const isRateLimited = (diagnosis?.error_type === 'rate_limit' && diagnosis?.is_transient) ||
    (() => { try { return detectRateLimitDeath(db, taskId).rateLimited; } catch (_) { return false; } })();

  if (isRateLimited) {
    const cooldownMinutes = getCooldown('rate_limit_cooldown_minutes', 5);
    log(`[persistent-revival] Rate-limit detected for ${taskId} — skipping crash-loop counter, setting ${cooldownMinutes}min cooldown`);

    // Record blocker_diagnosis with cooldown in persistent-tasks.db
    try {
      const ptDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
      if (fs.existsSync(ptDbPath)) {
        const ptDb = new Database(ptDbPath);
        ptDb.pragma('busy_timeout = 3000');
        const cooldownUntil = new Date(Date.now() + cooldownMinutes * 60 * 1000).toISOString();

        // Also set legacy metadata cooldown for backward compat
        try {
          const metaRow = ptDb.prepare('SELECT metadata FROM persistent_tasks WHERE id = ?').get(taskId);
          const meta = metaRow?.metadata ? JSON.parse(metaRow.metadata) : {};
          meta.rate_limit_cooldown_until = cooldownUntil;
          ptDb.prepare('UPDATE persistent_tasks SET metadata = ? WHERE id = ?').run(JSON.stringify(meta), taskId);
        } catch (_) { /* non-fatal */ }

        // Upsert blocker_diagnosis: if existing active/cooling_down diagnosis exists, update it
        try {
          // Check if blocker_diagnosis table exists first
          const tableExists = ptDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='blocker_diagnosis'").get();
          if (tableExists) {
            const existing = ptDb.prepare(
              "SELECT id, fix_attempts FROM blocker_diagnosis WHERE persistent_task_id = ? AND error_type = 'rate_limit' AND status IN ('active', 'cooling_down') LIMIT 1"
            ).get(taskId);
            if (existing) {
              ptDb.prepare("UPDATE blocker_diagnosis SET status = 'cooling_down', cooldown_until = ?, diagnosis_details = ? WHERE id = ?")
                .run(cooldownUntil, JSON.stringify(diagnosis || { error_type: 'rate_limit', is_transient: true }), existing.id);
            } else {
              ptDb.prepare(
                "INSERT INTO blocker_diagnosis (id, persistent_task_id, error_type, is_transient, diagnosis_details, status, cooldown_until, created_at) VALUES (?, ?, ?, 1, ?, 'cooling_down', ?, ?)"
              ).run(generateQueueId(), taskId, 'rate_limit', JSON.stringify(diagnosis || { error_type: 'rate_limit', is_transient: true }), cooldownUntil, new Date().toISOString());
            }
          }
        } catch (_) { /* non-fatal — blocker_diagnosis table may not exist yet */ }

        ptDb.close();
      }
    } catch (_) { /* non-fatal */ }

    // Record revival event with rate_limit_cooldown reason (excluded from hard count)
    try {
      db.prepare("INSERT INTO revival_events (id, task_id, reason, diagnosis, created_at) VALUES (?, ?, 'rate_limit_cooldown', ?, datetime('now'))")
        .run(generateQueueId(), taskId, diagnosis ? JSON.stringify(diagnosis) : null);
    } catch (_) { /* non-fatal */ }

    // Record in-memory (excluded from hard count)
    const entries = _monitorRevivalTimestamps.get(taskId) || [];
    entries.push({ ts: Date.now(), reason: 'rate_limit_cooldown' });
    _monitorRevivalTimestamps.set(taskId, entries.filter(e => e.ts > Date.now() - 60 * 60 * 1000));

    try { auditEvent('rate_limit_cooldown', { task_id: taskId, cooldown_minutes: cooldownMinutes, sample_error: diagnosis?.sample_error?.slice(0, 100) }); } catch (_) { /* non-fatal */ }
    return;
  }

  // Check if a rate-limit cooldown is still active (set by a previous rate-limit death)
  try {
    const ptDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
    if (fs.existsSync(ptDbPath)) {
      const ptDb = new Database(ptDbPath, { readonly: true });
      ptDb.pragma('busy_timeout = 3000');
      const metaRow = ptDb.prepare('SELECT metadata FROM persistent_tasks WHERE id = ?').get(taskId);
      const meta = metaRow?.metadata ? JSON.parse(metaRow.metadata) : {};
      ptDb.close();
      if (meta.rate_limit_cooldown_until) {
        const cooldownEnd = new Date(meta.rate_limit_cooldown_until).getTime();
        if (Date.now() < cooldownEnd) {
          const minsLeft = Math.ceil((cooldownEnd - Date.now()) / 60000);
          log(`[persistent-revival] Skipping revival for ${taskId}: rate-limit cooldown active (${minsLeft}min remaining)`);
          return;
        }
      }
    }
  } catch (_) { /* non-fatal — continue with normal revival */ }

  // Self-healing: attempt to diagnose and fix before circuit breaker
  // handleBlocker() uses only synchronous better-sqlite3 operations.
  if (diagnosis && diagnosis.error_type !== 'unknown' && diagnosis.consecutive_errors > 0) {
    try {
      if (_handleBlocker) {
        const healResult = _handleBlocker(taskId, diagnosis);
        if (healResult.action === 'escalated') {
          log(`[persistent-revival] Self-healing escalated for ${taskId} — bypass request submitted`);
          return; // Task paused + bypass request submitted — do not re-enqueue
        } else if (healResult.action === 'fix_spawned') {
          log(`[persistent-revival] Self-healing spawned fix task ${healResult.fixTaskId} for ${taskId}`);
          // Continue with normal re-enqueue — the revived monitor will check fix task status
        }
      }
    } catch (e) {
      log(`[persistent-revival] Self-healing handleBlocker error: ${e.message}`);
      // Non-fatal — continue with normal revival
    }
  }

  // In-memory rate limiter + DB fallback: max 3 hard revivals per task in 10 minutes
  // In-memory is fast path; DB is source of truth after process restart
  const memEntries = _monitorRevivalTimestamps.get(taskId) || [];
  const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
  let recentHardCount;
  if (memEntries.length > 0) {
    const recentEntries = memEntries.filter(e => e.ts > tenMinutesAgo);
    recentHardCount = recentEntries.filter(e => e.reason !== 'stale_heartbeat' && e.reason !== 'rate_limit_cooldown' && e.reason !== 'crash_backoff').length;
  } else {
    // Cold-start: read from DB (survives process restart)
    try {
      const dbRecent = db.prepare(
        "SELECT COUNT(*) as cnt FROM revival_events WHERE task_id = ? AND created_at > datetime('now', '-10 minutes') AND reason NOT IN ('stale_heartbeat', 'rate_limit_cooldown', 'crash_backoff')"
      ).get(taskId);
      recentHardCount = dbRecent?.cnt || 0;
    } catch (_) {
      recentHardCount = 0;
    }
  }
  if (recentHardCount >= 3) {
    const backoffCycle = Math.floor(recentHardCount / 3);
    const baseMinutes = getCooldown('crash_backoff_base_minutes', 5);
    const maxMinutes = getCooldown('crash_backoff_max_minutes', 60);
    const backoffMinutes = Math.min(maxMinutes, baseMinutes * Math.pow(2, backoffCycle - 1));
    log(`[persistent-revival] Crash backoff for ${taskId}: ${recentHardCount} hard revivals → ${backoffMinutes}min cooldown`);

    // Write blocker_diagnosis with cooling_down status (same pattern as rate limit cooldown)
    try {
      const ptDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
      if (fs.existsSync(ptDbPath)) {
        const ptDb2 = new Database(ptDbPath);
        ptDb2.pragma('busy_timeout = 3000');
        const cooldownUntil = new Date(Date.now() + backoffMinutes * 60 * 1000).toISOString();

        // Check if blocker_diagnosis table exists
        const tableExists = ptDb2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='blocker_diagnosis'").get();
        if (tableExists) {
          const existing = ptDb2.prepare(
            "SELECT id FROM blocker_diagnosis WHERE persistent_task_id = ? AND status IN ('active', 'cooling_down') LIMIT 1"
          ).get(taskId);
          if (existing) {
            ptDb2.prepare("UPDATE blocker_diagnosis SET status = 'cooling_down', cooldown_until = ? WHERE id = ?")
              .run(cooldownUntil, existing.id);
          } else {
            const diagDetails = diagnosis ? JSON.stringify(diagnosis) : JSON.stringify({ error_type: 'crash', suggested_action: 'investigate' });
            ptDb2.prepare(
              "INSERT INTO blocker_diagnosis (id, persistent_task_id, error_type, is_transient, diagnosis_details, status, cooldown_until, created_at) VALUES (?, ?, ?, 0, ?, 'cooling_down', ?, ?)"
            ).run(generateQueueId(), taskId, diagnosis?.error_type || 'crash', diagDetails, cooldownUntil, new Date().toISOString());
          }
        }
        ptDb2.close();
      }
    } catch (e) { log(`[persistent-revival] Failed to record crash backoff: ${e.message}`); }

    // Record revival event with crash_backoff reason (excluded from hard count)
    try {
      db.prepare("INSERT INTO revival_events (id, task_id, reason, diagnosis, created_at) VALUES (?, ?, 'crash_backoff', ?, datetime('now'))")
        .run(generateQueueId(), taskId, diagnosis ? JSON.stringify(diagnosis) : null);
    } catch (_) { /* non-fatal */ }

    // In-memory tracking (excluded from hard count)
    const entries2 = _monitorRevivalTimestamps.get(taskId) || [];
    entries2.push({ ts: Date.now(), reason: 'crash_backoff' });
    _monitorRevivalTimestamps.set(taskId, entries2.filter(e => e.ts > Date.now() - 60 * 60 * 1000));

    try { auditEvent('crash_backoff', { task_id: taskId, backoff_minutes: backoffMinutes, revival_count: recentHardCount }); } catch (_) { /* non-fatal */ }

    // Task stays ACTIVE — no pause, no do_not_auto_resume
    // The existing cooldown_recovery check in hourly-automation handles expired cooldowns
    return;
  }

  // Dedup: already queued, spawning, or running?
  const existing = db.prepare(
    "SELECT COUNT(*) as cnt FROM queue_items WHERE lane = 'persistent' AND status IN ('queued', 'running', 'spawning') AND json_extract(metadata, '$.persistentTaskId') = ?"
  ).get(taskId);
  if (existing && existing.cnt > 0) {
    const existingItem = db.prepare(
      "SELECT id, status FROM queue_items WHERE lane = 'persistent' AND status IN ('queued', 'running', 'spawning') AND json_extract(metadata, '$.persistentTaskId') = ? LIMIT 1"
    ).get(taskId);
    log(`[persistent-revival] Skipped revival for ${taskId}: existing ${existingItem?.status || 'queued/running'} monitor in queue (${existingItem?.id || 'unknown'})`);
    return;
  }

  // Plan-level dedup: if this task serves a plan, check if ANY monitor for the same plan
  // is already queued/running (regardless of persistentTaskId). Prevents duplicate monitors
  // when reviveOrphanedPlan() created multiple persistent tasks for the same plan.
  try {
    const ptDbPath2 = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
    if (fs.existsSync(ptDbPath2)) {
      const ptDbRo = new Database(ptDbPath2, { readonly: true });
      ptDbRo.pragma('busy_timeout = 3000');
      const taskRow = ptDbRo.prepare("SELECT metadata FROM persistent_tasks WHERE id = ?").get(taskId);
      ptDbRo.close();
      if (taskRow?.metadata) {
        const taskMeta = JSON.parse(taskRow.metadata);
        if (taskMeta.plan_id) {
          const planExisting = db.prepare(
            "SELECT id, status FROM queue_items WHERE lane = 'persistent' AND status IN ('queued', 'running', 'spawning') AND json_extract(metadata, '$.planId') = ? LIMIT 1"
          ).get(taskMeta.plan_id);
          if (planExisting) {
            log(`[persistent-revival] Skipped revival for ${taskId}: another monitor for plan ${taskMeta.plan_id} already ${planExisting.status} in queue (${planExisting.id})`);
            return;
          }
        }
      }
    }
  } catch (_) { /* non-fatal — fall through to persistentTaskId-based dedup */ }

  // Crash-loop circuit breaker: cap at 3 hard revivals per task in the last 10 minutes
  // Heartbeat-stale revivals are excluded from this count — they're routine recovery, not crashes.
  // NOTE: Use datetime('now', '-10 minutes') in SQL — NOT JS toISOString(). SQLite's datetime()
  // produces '2026-03-29 14:53:59' (space separator) while toISOString() produces
  // '2026-03-29T14:53:59.000Z' (T separator). String comparison breaks across formats.
  const dbRecentRevivals = db.prepare(
    "SELECT COUNT(*) as cnt FROM queue_items WHERE lane = 'persistent' AND json_extract(metadata, '$.persistentTaskId') = ? AND enqueued_at > datetime('now', '-10 minutes') AND COALESCE(json_extract(metadata, '$.revivalReason'), '') NOT IN ('heartbeat_stale_revival', 'rate_limit_cooldown', 'crash_backoff')"
  ).get(taskId);
  if (dbRecentRevivals && dbRecentRevivals.cnt >= 3) {
    const dbBackoffCycle = Math.floor(dbRecentRevivals.cnt / 3);
    const dbBaseMinutes = getCooldown('crash_backoff_base_minutes', 5);
    const dbMaxMinutes = getCooldown('crash_backoff_max_minutes', 60);
    const dbBackoffMinutes = Math.min(dbMaxMinutes, dbBaseMinutes * Math.pow(2, dbBackoffCycle - 1));
    log(`[persistent-revival] DB circuit breaker: crash backoff for ${taskId}: ${dbRecentRevivals.cnt} revivals → ${dbBackoffMinutes}min cooldown`);

    // Write blocker_diagnosis with cooling_down status
    try {
      const ptDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
      if (fs.existsSync(ptDbPath)) {
        const ptDb2 = new Database(ptDbPath);
        ptDb2.pragma('busy_timeout = 3000');
        const cooldownUntil = new Date(Date.now() + dbBackoffMinutes * 60 * 1000).toISOString();

        const tableExists = ptDb2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='blocker_diagnosis'").get();
        if (tableExists) {
          const existing = ptDb2.prepare(
            "SELECT id FROM blocker_diagnosis WHERE persistent_task_id = ? AND status IN ('active', 'cooling_down') LIMIT 1"
          ).get(taskId);
          if (existing) {
            ptDb2.prepare("UPDATE blocker_diagnosis SET status = 'cooling_down', cooldown_until = ? WHERE id = ?")
              .run(cooldownUntil, existing.id);
          } else {
            const diagDetails = diagnosis ? JSON.stringify(diagnosis) : JSON.stringify({ error_type: 'crash', suggested_action: 'investigate' });
            ptDb2.prepare(
              "INSERT INTO blocker_diagnosis (id, persistent_task_id, error_type, is_transient, diagnosis_details, status, cooldown_until, created_at) VALUES (?, ?, ?, 0, ?, 'cooling_down', ?, ?)"
            ).run(generateQueueId(), taskId, diagnosis?.error_type || 'crash', diagDetails, cooldownUntil, new Date().toISOString());
          }
        }
        ptDb2.close();
      }
    } catch (e) { log(`[persistent-revival] Failed to record DB crash backoff: ${e.message}`); }

    // Record revival event with crash_backoff reason
    try {
      db.prepare("INSERT INTO revival_events (id, task_id, reason, diagnosis, created_at) VALUES (?, ?, 'crash_backoff', ?, datetime('now'))")
        .run(generateQueueId(), taskId, diagnosis ? JSON.stringify(diagnosis) : null);
    } catch (_) { /* non-fatal */ }

    try { auditEvent('crash_backoff', { task_id: taskId, backoff_minutes: dbBackoffMinutes, revival_count: dbRecentRevivals.cnt }); } catch (_) { /* non-fatal */ }

    // Task stays ACTIVE — no pause, no do_not_auto_resume
    return;
  }

  // Check if task is still active
  const ptDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
  if (!fs.existsSync(ptDbPath)) return;

  const ptDb = new Database(ptDbPath, { readonly: true });
  const task = ptDb.prepare("SELECT id, title, status, metadata, monitor_session_id FROM persistent_tasks WHERE id = ?").get(taskId);
  ptDb.close();

  if (!task || task.status !== 'active') {
    log(`[persistent-revival] Skipped revival for ${taskId}: task ${!task ? 'not found' : `status='${task.status}' (must be active)`}`);
    return;
  }

  // Bypass request guard — belt-and-suspenders (task is typically paused, caught above)
  const bypassCheck = checkBypassBlock('persistent', taskId);
  if (bypassCheck.blocked) {
    log(`[persistent-revival] Skipped revival for ${taskId}: pending CTO bypass request ${bypassCheck.requestId}`);
    return;
  }

  // Build revival context from last known state
  let revivalContext = '';
  try {
    revivalContext = buildRevivalContext(taskId, PROJECT_DIR, { monitorSessionId: task.monitor_session_id });
  } catch (_) { /* non-fatal */ }

  // Check if demo/strict-infra/plan is involved
  let demoInstructions = '';
  let strictInfraInstructions = '';
  let planSection = '';
  try {
    const taskMeta = task.metadata ? JSON.parse(task.metadata) : {};
    if (taskMeta.demo_involved) {
      demoInstructions = buildPersistentMonitorDemoInstructions();
    }
    if (taskMeta.strict_infra_guidance === true) {
      strictInfraInstructions = buildPersistentMonitorStrictInfraInstructions();
    }
    if (taskMeta.plan_id) {
      planSection = `\nYou are a PLAN MANAGER for plan "${taskMeta.plan_title || taskMeta.plan_id}" (ID: ${taskMeta.plan_id}).
Follow the plan-manager agent instructions. Poll get_spawn_ready_tasks, create persistent tasks for ready plan steps, monitor them, and advance the plan until all phases complete.\n`;
    }
  } catch (_) { /* non-fatal */ }

  // Check for active self-healing fix tasks
  let selfHealSection = '';
  try {
    const ptDbSelfHeal = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
    if (fs.existsSync(ptDbSelfHeal)) {
      const ptDbRo2 = new Database(ptDbSelfHeal, { readonly: true });
      ptDbRo2.pragma('busy_timeout = 3000');
      try {
        const tableExists = ptDbRo2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='blocker_diagnosis'").get();
        if (tableExists) {
          const activeBlockers = ptDbRo2.prepare(
            "SELECT error_type, fix_attempts, max_fix_attempts, fix_task_ids, status, diagnosis_details FROM blocker_diagnosis WHERE persistent_task_id = ? AND status IN ('active', 'fix_in_progress', 'cooling_down') ORDER BY created_at DESC LIMIT 3"
          ).all(taskId);
          if (activeBlockers.length > 0) {
            const lines = activeBlockers.map(b => {
              let details;
              try { details = JSON.parse(b.diagnosis_details); } catch { details = {}; }
              return `- ${b.error_type} [${b.status}]: ${b.fix_attempts}/${b.max_fix_attempts} fix attempts. ${details.sample_error || ''}${b.fix_task_ids ? ` Fix tasks: ${b.fix_task_ids}` : ''}`;
            });
            selfHealSection = `\n## Active Self-Healing\n${lines.join('\n')}\n\nCheck fix task status before retrying blocked operations. If fixes were applied, verify they resolved the issue.\n`;
          }
        }
      } catch (_) { /* non-fatal */ }
      ptDbRo2.close();
    }
  } catch (_) { /* non-fatal */ }

  // Build enriched revival prompt with last known state
  const prompt = `[Automation][persistent-monitor][AGENT:{AGENT_ID}]

## Persistent Task: ${task.title}
${planSection}
Your previous monitor session died. Here is your last known state:
${revivalContext || '(no prior state available — this may be the first revival)'}
${selfHealSection}
Read full task details to fill any gaps:
mcp__persistent-task__get_persistent_task({ id: "${taskId}", include_amendments: true, include_subtasks: true })
${demoInstructions}${strictInfraInstructions}
Persistent Task ID: ${taskId}`;

  // Prefer --resume if monitor_session_id is available
  const resumeSessionId = task.monitor_session_id || null;
  const spawnType = resumeSessionId ? 'resume' : 'fresh';

  // Determine agent definition: plan-manager or persistent-monitor
  let agentDef = 'persistent-monitor';
  try {
    const taskMeta = task.metadata ? JSON.parse(task.metadata) : {};
    if (taskMeta.plan_id) agentDef = 'plan-manager';
  } catch (_) { /* non-fatal */ }

  const id = generateQueueId();
  db.prepare(`
    INSERT INTO queue_items (id, status, priority, lane, spawn_type, title, agent_type, hook_type,
      tag_context, prompt, model, cwd, mcp_config, resume_session_id, extra_args, extra_env,
      project_dir, worktree_path, metadata, source, agent, expires_at)
    VALUES (?, 'queued', 'critical', 'persistent', ?, ?, ?, ?, 'persistent-monitor', ?, NULL, NULL, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)
  `).run(
    id,
    spawnType,
    `[Persistent] Monitor revival: ${task.title}`,
    AGENT_TYPES.PERSISTENT_TASK_MONITOR,
    HOOK_TYPES.PERSISTENT_TASK_MONITOR,
    prompt,
    resumeSessionId,
    JSON.stringify(['--disallowedTools', 'Edit,Write,NotebookEdit']),
    JSON.stringify((() => {
      const env = { GENTYR_PERSISTENT_TASK_ID: taskId, GENTYR_PERSISTENT_MONITOR: 'true' };
      // Preserve plan-manager env vars if this is a plan-manager persistent task
      try {
        const taskMeta2 = task.metadata ? JSON.parse(task.metadata) : {};
        if (taskMeta2.plan_id) {
          env.GENTYR_PLAN_MANAGER = 'true';
          env.GENTYR_PLAN_ID = taskMeta2.plan_id;
        }
      } catch (_) { /* non-fatal */ }
      return env;
    })()),
    PROJECT_DIR,
    JSON.stringify((() => {
      const meta = { persistentTaskId: taskId, revivalReason: reapReason === 'stale_heartbeat' ? 'heartbeat_stale_revival' : 'immediate_reaper_revival' };
      // Include planId so plan-level dedup can detect duplicate monitors for the same plan
      try {
        const taskMeta3 = task.metadata ? JSON.parse(task.metadata) : {};
        if (taskMeta3.plan_id) meta.planId = taskMeta3.plan_id;
      } catch (_) { /* non-fatal */ }
      return meta;
    })()),
    'session-queue-reaper',
    agentDef,
  );

  auditEvent('session_enqueued', {
    queue_id: id,
    source: 'session-queue-reaper',
    agent_type: AGENT_TYPES.PERSISTENT_TASK_MONITOR,
    priority: 'critical',
    lane: 'persistent',
    title: `[Persistent] Monitor revival: ${task.title}`,
  });

  const revivalReason = reapReason === 'stale_heartbeat' ? 'heartbeat_stale_revival' : 'immediate_reaper_revival';
  log(`[persistent-revival] Enqueued revival for ${taskId} (reason: ${reapReason}, revivalReason: ${revivalReason}, spawnType: ${spawnType}, queueId: ${id})`);

  // Persist revival event (survives process restart)
  try {
    db.prepare("INSERT INTO revival_events (id, task_id, reason, diagnosis, created_at) VALUES (?, ?, ?, ?, datetime('now'))")
      .run(generateQueueId(), taskId, reapReason === 'stale_heartbeat' ? 'stale_heartbeat' : 'hard_revival', diagnosis ? JSON.stringify(diagnosis) : null);
  } catch (_) { /* non-fatal */ }

  // Record revival entry for in-memory rate limiting
  const entries = _monitorRevivalTimestamps.get(taskId) || [];
  entries.push({ ts: Date.now(), reason: reapReason });
  // Keep only last hour of entries
  _monitorRevivalTimestamps.set(taskId, entries.filter(e => e.ts > Date.now() - 60 * 60 * 1000));
}

// ============================================================================
// Priority Eligibility (Reserved Slots)
// ============================================================================

/**
 * Determine if a queue item is eligible to use reserved slots.
 * Priority-eligible items bypass the reserved slots cap and see the full maxConcurrent.
 * Non-eligible items see maxConcurrent - reservedSlots as their effective cap.
 *
 * An item is priority-eligible if:
 *   - priority is 'cto' or 'critical'
 *   - lane is 'persistent'
 *   - metadata contains persistentTaskId (child of a persistent task)
 *
 * @param {object} item - Queue item row
 * @returns {boolean}
 */
function isPriorityEligible(item) {
  if (item.priority === 'cto' || item.priority === 'critical') return true;
  if (item.lane === 'persistent') return true;
  try {
    const meta = item.metadata ? JSON.parse(item.metadata) : {};
    if (meta.persistentTaskId) return true;
  } catch (_) { /* non-fatal */ }
  return false;
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
  const result = { spawned: 0, queued: 0, atCapacity: false, failed: 0, memoryBlocked: 0, revivalCandidates: [] };

  // Step 1: Reap stale running items (dead PIDs, stuck sessions)
  let reaperResult = null;
  try {
    reaperResult = reapSyncPass(db);
    result.revivalCandidates = reaperResult.reaped.filter(r => r.revivalCandidate);
  } catch (err) {
    log(`Warning: ${err.message}`);
    // Fallback: existing simple PID check
    const running = db.prepare("SELECT id, pid, agent_id FROM queue_items WHERE status = 'running'").all();
    for (const item of running) {
      if (item.pid && !isPidAlive(item.pid)) {
        db.prepare("UPDATE queue_items SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(item.id);
        log(`Reaped stale running item ${item.id} (PID ${item.pid} dead)`);
      }
    }
  }

  // Step 1b: Immediately re-enqueue dead persistent monitors (no 15-min wait)
  if (reaperResult) {
    for (const item of reaperResult.reaped) {
      if (item.metadata?.persistentTaskId) {
        try {
          requeueDeadPersistentMonitor(db, item.metadata.persistentTaskId, item.reapReason, item.diagnosis || null);
        } catch (err) {
          log(`Persistent monitor re-enqueue error (non-fatal): ${err.message}`);
        }
      }
    }
  }

  // Step 1c: Catch-all — check for active persistent tasks with no running/queued monitor
  try {
    const ptDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
    if (Database && fs.existsSync(ptDbPath)) {
      const ptDb = new Database(ptDbPath, { readonly: true });
      const activeTasks = ptDb.prepare("SELECT id FROM persistent_tasks WHERE status = 'active'").all();
      ptDb.close();

      for (const task of activeTasks) {
        const existing = db.prepare(
          "SELECT id FROM queue_items WHERE lane = 'persistent' AND status IN ('queued', 'running', 'spawning') AND json_extract(metadata, '$.persistentTaskId') = ?"
        ).get(task.id);

        if (!existing) {
          // Bypass request guard — skip orphaned tasks with pending CTO bypass requests
          const bypassCheck1c = checkBypassBlock('persistent', task.id);
          if (bypassCheck1c.blocked) {
            log(`Step 1c: Skipping orphan ${task.id} — pending CTO bypass request ${bypassCheck1c.requestId}`);
            continue;
          }
          try {
            requeueDeadPersistentMonitor(db, task.id, 'orphan_catch_all');
          } catch (err) {
            log(`Step 1c persistent task orphan re-enqueue error (non-fatal): ${err.message}`);
          }
        }
      }
    }
  } catch (err) {
    log(`Step 1c persistent task orphan check error (non-fatal): ${err.message}`);
  }

  // Step 1d: Re-enqueue dead non-persistent task agents for revival
  // The reaper reset their TODO tasks to 'pending', but without a new queue item they'll never re-spawn.
  // Prefers --resume when the dead agent's session file is found; falls back to fresh.
  if (reaperResult && result.revivalCandidates.length > 0) {
    let revivalCount = 0;
    const MAX_NON_PERSISTENT_REVIVALS_PER_DRAIN = 3;
    const sessionDir = getSessionDir(PROJECT_DIR);

    for (const candidate of result.revivalCandidates) {
      if (revivalCount >= MAX_NON_PERSISTENT_REVIVALS_PER_DRAIN) break;

      // Skip persistent task agents — handled by Step 1b
      if (candidate.metadata?.persistentTaskId) continue;

      const taskId = candidate.metadata?.taskId;
      if (!taskId) continue;

      // Dedup: check if already queued for this task
      const existing = db.prepare(
        "SELECT id FROM queue_items WHERE status IN ('queued', 'running', 'spawning') AND json_extract(metadata, '$.taskId') = ?"
      ).get(taskId);
      if (existing) continue;

      // Bypass request guard — skip tasks with pending CTO bypass requests
      const bypassCheck1d = checkBypassBlock('todo', taskId);
      if (bypassCheck1d.blocked) {
        log(`Step 1d: Skipping revival for task ${taskId} — pending CTO bypass request ${bypassCheck1d.requestId}`);
        continue;
      }

      // Verify the task still exists and is pending in todo.db
      try {
        const todoDbPath = path.join(PROJECT_DIR, '.claude', 'todo.db');
        if (Database && fs.existsSync(todoDbPath)) {
          const todoDb = new Database(todoDbPath, { readonly: true });
          todoDb.pragma('busy_timeout = 3000');
          const task = todoDb.prepare("SELECT id, title, section, description, priority FROM tasks WHERE id = ? AND status = 'pending'").get(taskId);
          todoDb.close();
          if (task) {
            const revivalId = generateQueueId();
            const revivalPriority = task.priority === 'urgent' ? 'urgent' : 'normal';

            // Try to find the dead agent's session file for --resume
            let spawnType = 'fresh';
            let resumeSessionId = null;
            if (sessionDir && candidate.agentId) {
              const sessionFile = findSessionFileByAgentId(sessionDir, candidate.agentId);
              if (sessionFile) {
                const sid = extractSessionIdFromPath(sessionFile);
                if (sid) {
                  spawnType = 'resume';
                  resumeSessionId = sid;
                }
              }
            }

            // Check for resolved bypass request context
            let bypassCtxBlock = '';
            try {
              const bypassCtx = getBypassResolutionContext('todo', taskId);
              if (bypassCtx) {
                const decisionLabel = bypassCtx.decision === 'approved' ? 'APPROVED' : 'REJECTED';
                bypassCtxBlock = `\n## CTO Bypass Resolution\nYour previous session submitted a bypass request:\n  Category: ${bypassCtx.category}\n  Summary: ${bypassCtx.summary}\n\nCTO Decision: ${decisionLabel}\nCTO Instructions: "${bypassCtx.context}"\n\n${bypassCtx.decision === 'approved' ? 'Proceed with the work, following the CTO\'s instructions above.' : 'The CTO rejected your request. Take an alternative approach or wrap up without the bypassed action.'}\n`;
              }
            } catch (_) { /* non-fatal */ }

            const revivalPrompt = [
              `[Revival] Re-spawned after agent death.`,
              `Task: ${task.title}`,
              task.section ? `Section: ${task.section}` : null,
              task.description ? `\nDescription:\n${task.description}` : null,
              bypassCtxBlock || null,
              `\nThis task was previously being worked on by agent ${candidate.agentId} which died unexpectedly.`,
              `Continue from where the previous agent left off. Check the task status and any existing work before starting.`,
            ].filter(Boolean).join('\n');

            db.prepare(`
              INSERT INTO queue_items (id, status, priority, lane, spawn_type, title, agent_type, hook_type,
                tag_context, prompt, resume_session_id, project_dir, metadata, source, expires_at)
              VALUES (?, 'queued', ?, 'revival', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'session-queue-reaper', datetime('now', '+30 minutes'))
            `).run(
              revivalId,
              revivalPriority,
              spawnType,
              `[Revival] ${task.title || taskId}`,
              candidate.agentType || candidate.metadata?.agentType || 'task-runner',
              'session-reviver',
              `revival-${taskId.slice(0, 8)}`,
              revivalPrompt,
              resumeSessionId,
              PROJECT_DIR,
              JSON.stringify({ taskId, revivalReason: 'dead_agent_requeue', originalAgentId: candidate.agentId })
            );

            auditEvent('session_revival_triggered', {
              source: 'drain-step-1d',
              queue_id: revivalId,
              task_id: taskId,
              original_agent_id: candidate.agentId,
              spawn_type: spawnType,
            });

            log(`Step 1d: Re-enqueued dead task ${taskId} as ${revivalId} (revival lane, ${revivalPriority}, ${spawnType})`);
            revivalCount++;
          }
        }
      } catch (err) {
        log(`Step 1d revival re-enqueue error (non-fatal): ${err.message}`);
      }
    }
  }

  // Step 2: Expire old queued items past TTL
  const ttlResult = db.prepare("UPDATE queue_items SET status = 'cancelled', error = 'TTL expired', completed_at = datetime('now') WHERE status = 'queued' AND expires_at IS NOT NULL AND expires_at < datetime('now')").run();
  if (ttlResult.changes > 0) {
    auditEvent('session_ttl_expired', { count: ttlResult.changes });
  }

  // Step 2.5: Check for reserved_slots auto-restore
  try {
    const restoreRow = db.prepare('SELECT value FROM queue_config WHERE key = ?').get('reserved_slots_restore');
    if (restoreRow) {
      const { restoreAt, defaultValue } = JSON.parse(restoreRow.value);
      if (new Date(restoreAt) <= new Date()) {
        db.prepare("INSERT OR REPLACE INTO queue_config (key, value, updated_at) VALUES (?, ?, datetime('now'))")
          .run('reserved_slots', String(defaultValue));
        db.prepare("DELETE FROM queue_config WHERE key = 'reserved_slots_restore'").run();
        log(`Auto-restored reserved_slots to ${defaultValue}`);
      }
    }
  } catch (_) { /* non-fatal */ }

  // Step 2.6: Check for expired resource locks and promote next waiters
  try {
    checkAndExpireResources();
  } catch (_) { /* non-fatal — resource lock module may not be initialized */ }

  // Step 2.7: Cleanup stale port allocations from removed worktrees
  try {
    cleanupStalePortAllocations();
  } catch (_) { /* non-fatal — port allocator may not be available */ }

  // Step 3: Count running items by lane (suspended items do NOT count toward capacity)
  const standardRunning = db.prepare("SELECT COUNT(*) as cnt FROM queue_items WHERE status = 'running' AND lane NOT IN ('gate', 'persistent', 'audit')").get().cnt;
  const gateRunning = db.prepare("SELECT COUNT(*) as cnt FROM queue_items WHERE status = 'running' AND lane = 'gate'").get().cnt;
  const auditRunning = db.prepare("SELECT COUNT(*) as cnt FROM queue_items WHERE status = 'running' AND lane = 'audit'").get().cnt;
  const maxConcurrent = getMaxConcurrentSessions();
  const reservedSlots = getReservedSlots();

  // Step 4: Get queued items ordered by priority then enqueue time
  // Revival lane items first, then gate, then standard
  // cto is the highest priority level (0), followed by critical (1), urgent (2), normal (3), low (4)
  const queued = db.prepare(`
    SELECT * FROM queue_items WHERE status = 'queued'
    ORDER BY
      CASE lane WHEN 'revival' THEN 0 WHEN 'persistent' THEN 1 WHEN 'gate' THEN 2 ELSE 3 END,
      CASE priority WHEN 'cto' THEN 0 WHEN 'critical' THEN 1 WHEN 'urgent' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
      enqueued_at ASC
  `).all();

  result.queued = queued.length;

  debugLog('session-queue', 'drain_start', { queuedCount: queued.length });

  // Track spawns per lane this drain cycle to avoid stale counter bugs
  let standardSpawnedThisDrain = 0;
  let gateSpawnedThisDrain = 0;
  let auditSpawnedThisDrain = 0;
  let persistentSpawnedThisDrain = 0;

  for (const item of queued) {
    if (item.lane === 'persistent') {
      // Persistent lane has no capacity limit — monitors always spawn immediately
    } else if (item.lane === 'gate') {
      // Gate lane has its own sub-limit (tracked separately from main capacity)
      if (gateRunning + gateSpawnedThisDrain >= GATE_LANE_LIMIT) {
        continue; // Skip, gate full
      }
    } else if (item.lane === 'audit') {
      // Audit lane has its own sub-limit (independent auditors, signal-excluded)
      if (auditRunning + auditSpawnedThisDrain >= AUDIT_LANE_LIMIT) {
        continue; // Skip, audit full
      }
    } else {
      // Standard + revival lanes share the main limit (gate and persistent spawns don't consume it)
      // Reserved slots: non-priority-eligible items see maxConcurrent - reservedSlots as their cap.
      // Priority-eligible items (cto/critical/persistent/persistentTaskId children) see the full maxConcurrent.
      const effectiveMax = isPriorityEligible(item) ? maxConcurrent : maxConcurrent - reservedSlots;
      if (standardRunning + standardSpawnedThisDrain >= effectiveMax) {
        // Inline preemption: cto/critical items suspend the lowest-priority running session
        if (item.priority === 'cto' || item.priority === 'critical') {
          const preempted = preemptLowestPriority(db, item);
          if (preempted) {
            log(`Preempted ${preempted.id} (${preempted.priority}) for ${item.id} (${item.priority})`);
            // Net zero: freed one slot, about to fill it — don't increment standardSpawnedThisDrain extra
          } else {
            result.atCapacity = true;
            break;
          }
        } else if (isPriorityEligible(item)) {
          // Priority-eligible but not cto/critical — can't preempt, but don't break the loop.
          // There may be items later that CAN preempt or fit in reserved slots.
          continue;
        } else {
          // Non-eligible item hit the reduced cap — skip it but keep checking
          // for priority-eligible items that can use reserved slots
          continue;
        }
      }
    }

    // Memory pressure check
    const memCheck = shouldAllowSpawn({
      priority: item.priority,
      context: `session-queue:${item.source}`,
    });
    if (!memCheck.allowed) {
      result.memoryBlocked++;
      log(`Memory pressure blocked ${item.id}: ${memCheck.reason}`);
      debugLog('session-queue', 'drain_memory_blocked', { queueId: item.id, priority: item.priority, pressure: memCheck.pressure });
      continue; // Skip this item, try next (might be higher priority)
    }

    // Workstream dependency check — skip items whose blocker tasks are not yet completed
    const taskId = item.metadata ? (() => { try { return JSON.parse(item.metadata).taskId; } catch (e) { return null; } })() : null;
    if (taskId) {
      try {
        const wsDbPath = path.join(item.project_dir || PROJECT_DIR, '.claude', 'state', 'workstream.db');
        if (fs.existsSync(wsDbPath)) {
          const wsDb = new Database(wsDbPath, { readonly: true });
          const activeDeps = wsDb.prepare(
            "SELECT blocker_task_id FROM queue_dependencies WHERE blocked_task_id = ? AND status = 'active'"
          ).all(taskId);
          wsDb.close();

          if (activeDeps.length > 0) {
            // Check if all blockers are completed in todo.db
            const todoDbPath = path.join(item.project_dir || PROJECT_DIR, '.claude', 'todo.db');
            if (fs.existsSync(todoDbPath)) {
              const todoDb = new Database(todoDbPath, { readonly: true });
              const allMet = activeDeps.every(dep => {
                const task = todoDb.prepare("SELECT status FROM tasks WHERE id = ?").get(dep.blocker_task_id);
                return task && task.status === 'completed';
              });
              todoDb.close();

              if (!allMet) {
                log(`Workstream dep check: skipping ${item.id} (task ${taskId}) — active dependencies not yet satisfied`);
                continue; // Skip, try next item
              }
            }
          }
        }
      } catch (e) {
        // Fail open — if workstream DB doesn't exist or error occurs, allow spawning
        log(`Workstream dep check: ignoring error for ${item.id}: ${e.message}`);
      }
    }

    // Attempt to spawn
    try {
      spawnQueueItem(db, item);
      debugLog('session-queue', 'drain_spawn', { queueId: item.id, title: item.title, lane: item.lane });
      result.spawned++;
      if (item.lane === 'gate') {
        gateSpawnedThisDrain++;
      } else if (item.lane === 'audit') {
        auditSpawnedThisDrain++;
      } else if (item.lane === 'persistent') {
        persistentSpawnedThisDrain++;
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

  // Step 6: Resume suspended sessions if capacity available
  try {
    const currentRunning = db.prepare(
      "SELECT COUNT(*) as cnt FROM queue_items WHERE status = 'running' AND lane NOT IN ('gate', 'persistent')"
    ).get().cnt;
    if (currentRunning < maxConcurrent) {
      const slotsAvailable = maxConcurrent - currentRunning;
      const suspended = db.prepare(`
        SELECT id, pid, priority, metadata, project_dir FROM queue_items WHERE status = 'suspended'
        ORDER BY
          CASE priority WHEN 'cto' THEN 0 WHEN 'critical' THEN 1 WHEN 'urgent' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
          enqueued_at ASC
        LIMIT ?
      `).all(slotsAvailable);

      for (const s of suspended) {
        if (s.pid && isPidAlive(s.pid)) {
          db.prepare("UPDATE queue_items SET status = 'running' WHERE id = ?").run(s.id);
          killProcessGroup(s.pid, 'SIGCONT');
          log(`Resumed suspended session ${s.id} (PID ${s.pid})`);
          auditEvent('session_resumed', { queue_id: s.id, pid: s.pid, priority: s.priority });
        } else {
          // PID died while suspended — mark completed and reset linked TODO task
          db.prepare("UPDATE queue_items SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(s.id);
          log(`Suspended session ${s.id} died while paused (PID ${s.pid})`);
          // Reset linked TODO task to pending so it can be re-claimed
          try {
            const sMeta = s.metadata ? JSON.parse(s.metadata) : {};
            if (sMeta.taskId) {
              const todoDbPath = path.join(s.project_dir || PROJECT_DIR, '.claude', 'todo.db');
              if (fs.existsSync(todoDbPath)) {
                const todoDB = new Database(todoDbPath);
                todoDB.prepare("UPDATE tasks SET status = 'pending', started_at = NULL, started_timestamp = NULL WHERE id = ? AND status = 'in_progress'").run(sMeta.taskId);
                todoDB.close();
                log(`Reset task ${sMeta.taskId} to pending (agent died while suspended)`);
              }
            }
          } catch (todoErr) {
            log(`Failed to reset TODO for suspended session ${s.id}: ${todoErr.message}`);
          }
        }
      }
    }
  } catch (err) {
    log(`Step 6 resume suspended error (non-fatal): ${err.message}`);
  }

  const reaped = reaperResult?.reaped?.length || 0;
  if (result.spawned > 0 || reaped > 0) {
    const runningCount = db.prepare("SELECT COUNT(*) as cnt FROM queue_items WHERE status = 'running'").get()?.cnt || 0;
    log(`Drain complete: spawned=${result.spawned}, reaped=${reaped}, queued=${result.queued}, running=${runningCount}`);
  }

  debugLog('session-queue', 'drain_complete', { spawned: result.spawned, queued: result.queued, atCapacity: result.atCapacity, failed: result.failed });

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
    prompt = `[Automation][${item.tag_context}][AGENT:${agentId}] ${item.title}`;
  }

  // Ensure the prompt has the standard tag prefix
  if (!prompt.startsWith('[Automation]') && !prompt.startsWith('[Task]')) {
    prompt = `[Automation][${item.tag_context}][AGENT:${agentId}] ${prompt}`;
  }

  // Update agent-tracker with final prompt
  updateAgent(agentId, { prompt });

  // Build spawn args
  const spawnArgs = [];
  if (item.spawn_type === 'resume' && item.resume_session_id) {
    spawnArgs.push('--resume', item.resume_session_id);
  }
  spawnArgs.push('--dangerously-skip-permissions');
  if (item.agent) {
    spawnArgs.push('--agent', item.agent);
  }
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

  // Enforce tool restrictions for persistent task monitors (belt-and-suspenders)
  if (item.agent_type === AGENT_TYPES.PERSISTENT_TASK_MONITOR) {
    if (!spawnArgs.includes('--disallowedTools')) {
      spawnArgs.push('--disallowedTools', 'Edit,Write,NotebookEdit');
    }
  }

  spawnArgs.push('-p', prompt);

  // Build environment
  const extraEnv = item.extra_env ? JSON.parse(item.extra_env) : {};
  const spawnEnv = buildSpawnEnv(agentId, {
    projectDir: item.project_dir,
    extraEnv,
  });

  // Inject CLAUDE_WORKTREE_DIR for worktree-spawned agents so hooks can detect worktree context
  if (item.worktree_path) {
    spawnEnv.CLAUDE_WORKTREE_DIR = item.worktree_path;
  }

  // Inject CLAUDE_QUEUE_ID so hooks can identify the current session's queue entry
  spawnEnv.CLAUDE_QUEUE_ID = item.id;

  // Spawn — validate CWD exists, fall back to project dir if worktree was cleaned up
  let effectiveCwd = item.cwd || item.worktree_path || item.project_dir;
  if (effectiveCwd && !fs.existsSync(effectiveCwd)) {
    log(`Warning: CWD ${effectiveCwd} does not exist, falling back to project dir`);
    effectiveCwd = item.project_dir;
    // Clear worktree env since the path is gone
    delete spawnEnv.CLAUDE_WORKTREE_DIR;
  }

  const claude = spawn('claude', spawnArgs, {
    detached: true,
    stdio: 'ignore',
    cwd: effectiveCwd,
    env: spawnEnv,
  });

  // Attach error handler IMMEDIATELY to prevent unhandled 'error' event crash.
  // The !pid check below handles spawn failures synchronously.
  claude.on('error', () => {});

  claude.unref();

  if (!claude.pid) {
    throw new Error(`spawn returned no PID (cwd: ${effectiveCwd})`);
  }

  // Update DB and agent-tracker
  db.prepare("UPDATE queue_items SET status = 'running', agent_id = ?, pid = ?, spawned_at = datetime('now') WHERE id = ?")
    .run(agentId, claude.pid, item.id);
  updateAgent(agentId, { pid: claude.pid, status: 'running' });

  log(`Spawned ${item.id} as agent ${agentId} (PID ${claude.pid}): "${item.title}"`);

  // Write monitor_pid/monitor_agent_id to persistent_tasks if this is a persistent monitor
  try {
    const metadata = item.metadata ? (typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata) : {};
    if (metadata.persistentTaskId) {
      const ptDbPath = path.join(item.project_dir || PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
      if (fs.existsSync(ptDbPath)) {
        const ptDb = new Database(ptDbPath);
        ptDb.pragma('busy_timeout = 3000');
        ptDb.prepare("UPDATE persistent_tasks SET monitor_pid = ?, monitor_agent_id = ? WHERE id = ?")
          .run(claude.pid, agentId, metadata.persistentTaskId);
        ptDb.close();
      }
    }
  } catch (_) { /* non-fatal */ }

  auditEvent('session_spawned', {
    queue_id: item.id,
    agent_id: agentId,
    pid: claude.pid,
    source: item.source,
    agent_type: item.agent_type,
    title: item.title,
  });
}

// ============================================================================
// Inline Preemption (SIGTSTP-based — suspends without killing)
// ============================================================================

/**
 * Preempt the lowest-priority running session by suspending it with SIGTSTP.
 * Used by drainQueue() when a cto/critical item can't spawn due to capacity.
 *
 * Unlike preemptForCtoTask() (which kills and re-enqueues), this uses SIGTSTP
 * to pause the process. The session stays alive and is resumed with SIGCONT
 * when capacity frees up.
 *
 * @param {Database} db - Queue database handle
 * @param {object} incomingItem - The high-priority queue item that needs a slot
 * @returns {object|null} The preempted item, or null if nothing could be preempted
 */
function preemptLowestPriority(db, incomingItem) {
  const candidate = db.prepare(`
    SELECT id, pid, priority, agent_type, title, spawned_at FROM queue_items
    WHERE status = 'running' AND lane NOT IN ('gate', 'persistent')
      AND priority IN ('low', 'normal', 'urgent')
    ORDER BY
      CASE priority WHEN 'low' THEN 0 WHEN 'normal' THEN 1 WHEN 'urgent' THEN 2 END ASC,
      spawned_at ASC
    LIMIT 1
  `).get();

  if (!candidate) return null;

  const priorityRank = { low: 0, normal: 1, urgent: 2, critical: 3, cto: 4 };
  if (priorityRank[candidate.priority] >= priorityRank[incomingItem.priority]) return null;

  db.prepare("UPDATE queue_items SET status = 'suspended', completed_at = NULL WHERE id = ?")
    .run(candidate.id);

  killProcessGroup(candidate.pid, 'SIGTSTP');

  auditEvent('session_preempted', {
    preempted_queue_id: candidate.id,
    preempted_pid: candidate.pid,
    preempted_priority: candidate.priority,
    preempted_by_queue_id: incomingItem.id,
    preempted_by_priority: incomingItem.priority,
  });

  return candidate;
}

// ============================================================================
// CTO Priority Preemption
// ============================================================================

/**
 * Preempt the lowest-priority running session to make room for a CTO task.
 *
 * Called after enqueuing a CTO-priority task when the queue is at capacity.
 * If there's already capacity available, returns immediately (drain handles it).
 * If at capacity, kills the lowest-priority non-CTO running session, suspends
 * it, writes its session info to suspended-sessions.json, and re-enqueues it
 * as a resume item. Then drains the queue to spawn the CTO task.
 *
 * @param {string} ctoQueueId - Queue ID of the CTO task to make room for
 * @param {string} projectDir - Project directory
 * @returns {Promise<{ preempted: boolean, preemptedQueueId?: string, preemptedAgentId?: string }>}
 */
export async function preemptForCtoTask(ctoQueueId, projectDir) {
  const db = getDb();
  const resolvedProjectDir = projectDir || PROJECT_DIR;

  // Check current capacity
  const standardRunning = db.prepare("SELECT COUNT(*) as cnt FROM queue_items WHERE status = 'running' AND lane NOT IN ('gate', 'persistent')").get().cnt;
  const maxConcurrent = getMaxConcurrentSessions();

  if (standardRunning < maxConcurrent) {
    // There's room — drain will handle spawning the CTO task
    log(`preemptForCtoTask: capacity available (${standardRunning}/${maxConcurrent}), no preemption needed`);
    drainQueue();
    return { preempted: false };
  }

  // At capacity — find the lowest-priority running session to preempt
  // Prefer lowest priority, then longest-running (most work is saved if we keep it)
  // Exclude gate lane and CTO-priority items
  const victim = db.prepare(`
    SELECT id, pid, agent_id, title, agent_type, hook_type, cwd, project_dir,
           worktree_path, metadata, spawned_at, priority, lane
    FROM queue_items
    WHERE status = 'running' AND lane NOT IN ('gate', 'persistent') AND priority != 'cto'
    ORDER BY
      CASE priority WHEN 'low' THEN 0 WHEN 'normal' THEN 1
                    WHEN 'urgent' THEN 2 WHEN 'critical' THEN 3 ELSE 4 END,
      spawned_at ASC
    LIMIT 1
  `).get();

  if (!victim) {
    // All running sessions are CTO-priority or gate — cannot preempt
    log(`preemptForCtoTask: no preemptable sessions found (all are CTO-priority, gate, or persistent)`);
    drainQueue();
    return { preempted: false };
  }

  const pid = victim.pid;
  const agentId = victim.agent_id;

  log(`preemptForCtoTask: preempting ${victim.id} (agent: ${agentId}, PID: ${pid}, priority: ${victim.priority}, title: "${victim.title}")`);

  // Calculate elapsed time for the prompt
  const spawnedAt = victim.spawned_at ? parseSqliteDatetime(victim.spawned_at) : new Date();
  const elapsedMs = Date.now() - spawnedAt.getTime();
  const elapsedMins = Math.floor(elapsedMs / 60000);
  const elapsedHours = Math.floor(elapsedMins / 60);
  const elapsed = elapsedHours > 0
    ? `${elapsedHours}h ${elapsedMins % 60}m`
    : `${elapsedMins}m`;

  // Write suspended session info BEFORE killing the process
  const suspendedPath = path.join(resolvedProjectDir, '.claude', 'state', 'suspended-sessions.json');
  try {
    const stateDir = path.dirname(suspendedPath);
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }

    let existing = [];
    if (fs.existsSync(suspendedPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(suspendedPath, 'utf8'));
        existing = Array.isArray(raw) ? raw : [raw];
      } catch (err) {
        log(`Warning: could not parse suspended-sessions.json: ${err.message}`);
      }
    }

    existing.push({
      sessionId: null, // will be resolved from JSONL file below
      agentId,
      queueId: victim.id,
      pid,
      suspendedAt: new Date().toISOString(),
    });

    fs.writeFileSync(suspendedPath, JSON.stringify(existing, null, 2));
  } catch (err) {
    // Non-fatal — log and continue, the stop hook fallback will still handle it
    log(`preemptForCtoTask: failed to write suspended-sessions.json: ${err.message}`);
  }

  // Verify PID identity before killing (defense against PID reuse)
  if (!isClaudeProcess(pid)) {
    log(`preemptForCtoTask: PID ${pid} is no longer a Claude process — skipping`);
    return;
  }

  // Send SIGTERM to the victim process
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    // Already dead — continue
    log(`preemptForCtoTask: SIGTERM failed for PID ${pid} (already dead?): ${err.message}`);
  }

  // Wait up to 5s for the process to die (poll every 500ms)
  let died = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      process.kill(pid, 0);
      // Still alive — keep waiting
    } catch (_) {
      died = true;
      break;
    }
  }

  if (!died) {
    log(`preemptForCtoTask: PID ${pid} did not die within 5s after SIGTERM`);
  } else {
    log(`preemptForCtoTask: PID ${pid} died after SIGTERM`);
  }

  // Find the session JSONL file to get the session ID for resumption
  let sessionId = null;
  try {
    const sessionDir = getSessionDir(resolvedProjectDir);
    if (sessionDir && agentId) {
      const sessionFile = findSessionFileByAgentId(sessionDir, agentId);
      if (sessionFile) {
        sessionId = extractSessionIdFromPath(sessionFile);
        log(`preemptForCtoTask: found session file for agent ${agentId}: ${sessionId}`);
      }
    }
  } catch (err) {
    log(`preemptForCtoTask: failed to find session file for agent ${agentId}: ${err.message}`);
  }

  // Update the suspended-sessions.json with the resolved sessionId
  if (sessionId) {
    try {
      let existing = [];
      if (fs.existsSync(suspendedPath)) {
        try {
          const raw = JSON.parse(fs.readFileSync(suspendedPath, 'utf8'));
          existing = Array.isArray(raw) ? raw : [raw];
        } catch (err) {
          log(`Warning: ${err.message}`);
        }
      }
      const entry = existing.find(e => e.agentId === agentId && e.queueId === victim.id);
      if (entry) {
        entry.sessionId = sessionId;
        fs.writeFileSync(suspendedPath, JSON.stringify(existing, null, 2));
      }
    } catch (err) {
      log(`preemptForCtoTask: failed to update suspended-sessions.json with sessionId: ${err.message}`);
    }
  }

  // Mark the preempted queue item as suspended
  db.prepare("UPDATE queue_items SET status = 'suspended', completed_at = NULL WHERE id = ?").run(victim.id);

  // Reset the linked TODO task to pending (if any) so it can be re-claimed
  let victimMetadata = {};
  try {
    victimMetadata = victim.metadata ? JSON.parse(victim.metadata) : {};
  } catch (err) {
    log(`Warning: could not parse victim metadata: ${err.message}`);
  }

  if (victimMetadata.taskId) {
    const todoDbPath = path.join(resolvedProjectDir, '.claude', 'todo.db');
    if (fs.existsSync(todoDbPath)) {
      try {
        const todoDB = new Database(todoDbPath);
        todoDB.prepare(
          "UPDATE tasks SET status = 'pending', started_at = NULL, started_timestamp = NULL WHERE id = ? AND status = 'in_progress'"
        ).run(victimMetadata.taskId);
        todoDB.close();
        log(`preemptForCtoTask: reset task ${victimMetadata.taskId} to pending`);
      } catch (err) {
        log(`preemptForCtoTask: failed to reset task ${victimMetadata.taskId}: ${err.message}`);
      }
    }
  }

  // Re-enqueue the suspended session as a resume item (if we have a session ID)
  if (sessionId) {
    try {
      const resumePrompt = `[SESSION SUSPENDED] This session was preempted by a CTO-directed task.\nYou were working on: "${victim.title}". ${elapsed} has passed.\nBefore continuing, verify your task status via mcp__todo-db__get_task.\nCheck for any CTO directives via mcp__agent-tracker__get_session_signals.`;

      enqueueSession({
        spawnType: 'resume',
        resumeSessionId: sessionId,
        priority: 'urgent',
        lane: 'standard',
        title: `[RESUMED] ${victim.title}`,
        agentType: victim.agent_type,
        hookType: victim.hook_type,
        tagContext: 'preemption-resume',
        source: 'preemption',
        prompt: resumePrompt,
        cwd: victim.cwd || victim.worktree_path || victim.project_dir,
        projectDir: resolvedProjectDir,
        worktreePath: victim.worktree_path || null,
        metadata: victimMetadata,
      });
      log(`preemptForCtoTask: re-enqueued suspended session ${sessionId.slice(0, 8)} as resume item`);
    } catch (err) {
      log(`preemptForCtoTask: failed to re-enqueue suspended session: ${err.message}`);
    }
  } else {
    log(`preemptForCtoTask: no session ID found for preempted agent ${agentId} — cannot re-enqueue for resume`);
  }

  // Emit audit events
  try {
    auditEvent('session_suspended', {
      queue_id: victim.id,
      agent_id: agentId,
      pid,
      title: victim.title,
      priority: victim.priority,
      elapsed,
      cto_queue_id: ctoQueueId,
      session_id: sessionId,
    });
    auditEvent('session_preempted', {
      cto_queue_id: ctoQueueId,
      preempted_queue_id: victim.id,
      preempted_agent_id: agentId,
      preempted_title: victim.title,
    });
  } catch (err) {
    log(`Warning: failed to emit audit events: ${err.message}`);
  }

  // The drainQueue() calls inside enqueueSession (for the resume item, if applicable)
  // will spawn the CTO task because 'cto' priority outranks 'urgent'.
  // If no session ID was found (re-enqueue skipped), drain explicitly to spawn the CTO task.
  if (!sessionId) {
    drainQueue();
  }

  return { preempted: true, preemptedQueueId: victim.id, preemptedAgentId: agentId };
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
  auditEvent('session_cancelled', { queue_id: queueId });
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
    auditEvent('session_completed', { agent_id: agentId });
    // Immediately drain queue — a slot just freed up
    try { drainQueue(); } catch (e) { log(`drainQueue after completion failed: ${e.message}`); }
    return true;
  }
  return false;
}

// ============================================================================
// Mark Failed
// ============================================================================

/**
 * Mark a running item as failed by agent ID.
 * @param {string} agentId
 * @param {string} error - Error description
 * @returns {boolean}
 */
export function markFailed(agentId, error) {
  const db = getDb();
  const result = db.prepare("UPDATE queue_items SET status = 'failed', error = ?, completed_at = datetime('now') WHERE agent_id = ? AND status = 'running'").run(error, agentId);
  if (result.changes > 0) {
    log(`Marked failed: agent ${agentId} (${error})`);
    auditEvent('session_failed', { agent_id: agentId, error });
    // Immediately drain queue — a slot just freed up
    try { drainQueue(); } catch (e) { log(`drainQueue after failure failed: ${e.message}`); }
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
  try {
    reapSyncPass(db);
  } catch (err) {
    log(`Warning: ${err.message}`);
    // Fallback: simple PID check
    const runningItems = db.prepare("SELECT * FROM queue_items WHERE status = 'running' ORDER BY spawned_at ASC").all();
    for (const item of runningItems) {
      if (item.pid && !isPidAlive(item.pid)) {
        db.prepare("UPDATE queue_items SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(item.id);
      }
    }
  }

  // Re-query after reaping
  const activeRunning = db.prepare("SELECT * FROM queue_items WHERE status = 'running' ORDER BY spawned_at ASC").all();
  const queuedItems = db.prepare("SELECT * FROM queue_items WHERE status = 'queued' ORDER BY enqueued_at ASC").all();
  const suspendedItems = db.prepare("SELECT * FROM queue_items WHERE status = 'suspended' ORDER BY spawned_at ASC").all();

  // 24h stats
  const completed24h = db.prepare("SELECT COUNT(*) as cnt FROM queue_items WHERE status IN ('completed', 'failed') AND completed_at > datetime('now', '-24 hours')").get().cnt;
  const avgWait = db.prepare("SELECT AVG(CAST((julianday(spawned_at) - julianday(enqueued_at)) * 86400 AS INTEGER)) as avg_secs FROM queue_items WHERE spawned_at IS NOT NULL AND enqueued_at IS NOT NULL AND spawned_at > datetime('now', '-24 hours')").get();
  const avgRun = db.prepare("SELECT AVG(CAST((julianday(completed_at) - julianday(spawned_at)) * 86400 AS INTEGER)) as avg_secs FROM queue_items WHERE completed_at IS NOT NULL AND spawned_at IS NOT NULL AND completed_at > datetime('now', '-24 hours')").get();
  const bySource = db.prepare("SELECT source, COUNT(*) as cnt FROM queue_items WHERE enqueued_at > datetime('now', '-24 hours') GROUP BY source ORDER BY cnt DESC LIMIT 10").all();

  const now = Date.now();

  const reservedSlots = getReservedSlots();
  const restoreRow = db.prepare('SELECT value FROM queue_config WHERE key = ?').get('reserved_slots_restore');
  let reservedSlotsRestore = null;
  if (restoreRow) {
    try { reservedSlotsRestore = JSON.parse(restoreRow.value); } catch (_) { /* non-fatal */ }
  }

  return {
    hasData: true,
    maxConcurrent,
    reservedSlots,
    reservedSlotsRestore,
    focusMode: isFocusModeEnabled(),
    localMode: isLocalModeEnabled(),
    running: activeRunning.length,
    suspended: suspendedItems.length,
    availableSlots: Math.max(0, maxConcurrent - activeRunning.length),
    queuedItems: queuedItems.map(item => ({
      id: item.id,
      title: item.title,
      priority: item.priority,
      lane: item.lane,
      source: item.source,
      waitTime: formatElapsed(now - parseSqliteDatetime(item.enqueued_at).getTime()),
    })),
    runningItems: activeRunning.map(item => ({
      id: item.id,
      title: item.title,
      source: item.source,
      agentType: item.agent_type,
      agentId: item.agent_id,
      pid: item.pid,
      elapsed: item.spawned_at ? formatElapsed(now - parseSqliteDatetime(item.spawned_at).getTime()) : 'unknown',
    })),
    suspendedItems: suspendedItems.map(item => ({
      id: item.id,
      title: item.title,
      source: item.source,
      agentType: item.agent_type,
      agentId: item.agent_id,
      elapsed: item.spawned_at ? formatElapsed(now - parseSqliteDatetime(item.spawned_at).getTime()) : 'unknown',
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

// ============================================================================
// Activate Queued Item (for MCP tool)
// ============================================================================

/**
 * Instantly activate a queued session by boosting its priority to CTO and draining.
 * The inline preemption logic in drainQueue() handles suspending a lower-priority
 * running session if the queue is at capacity.
 *
 * @param {string} queueId - Queue item ID to activate
 * @returns {object} Result with success, queue_id, original_priority, drain_result
 */
export function activateQueuedItem(queueId) {
  const db = getDb();

  const item = db.prepare('SELECT * FROM queue_items WHERE id = ?').get(queueId);
  if (!item) return { success: false, error: 'Queue item not found' };
  if (item.status !== 'queued') return { success: false, error: `Item is ${item.status}, not queued` };

  const originalPriority = item.priority;

  // Boost priority to 'cto' so inline preemption fires if needed
  db.prepare("UPDATE queue_items SET priority = 'cto' WHERE id = ?").run(queueId);

  // Drain — preemption will kick in if at capacity
  const drainResult = drainQueue();

  // Check if it spawned
  const updated = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(queueId);
  const activated = updated && (updated.status === 'running' || updated.status === 'spawning');

  if (!activated) {
    // Revert priority if it didn't spawn
    db.prepare('UPDATE queue_items SET priority = ? WHERE id = ?').run(originalPriority, queueId);
  }

  auditEvent('session_activated', {
    queue_id: queueId,
    original_priority: originalPriority,
    activated,
    drain_result: drainResult,
  });

  return { success: activated, queue_id: queueId, original_priority: originalPriority, drain_result: drainResult };
}
