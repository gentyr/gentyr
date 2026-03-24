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
import { reapSyncPass } from './session-reaper.js';
import { auditEvent } from './session-audit.js';
// NOTE: revival-utils.js imports from session-queue.js (circular dep), so we
// inline these three utilities here instead of importing from revival-utils.js.
// Mirrors the same pattern used in session-reaper.js.

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
  } catch (err) {
    console.error('[session-queue] Warning:', err.message);
    // Non-fatal
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
    console.error('[session-queue] Warning:', err.message);
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
      console.error('[session-queue] Warning:', err.message);
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

  auditEvent('session_enqueued', {
    queue_id: id,
    source: spec.source,
    agent_type: spec.agentType,
    priority: spec.priority || 'normal',
    lane: spec.lane || 'standard',
    title: spec.title,
  });

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
  const result = { spawned: 0, queued: 0, atCapacity: false, failed: 0, revivalCandidates: [] };

  // Step 1: Reap stale running items (dead PIDs, stuck sessions)
  try {
    const reaperResult = reapSyncPass(db);
    result.revivalCandidates = reaperResult.reaped.filter(r => r.revivalCandidate);
  } catch (err) {
    console.error('[session-queue] Warning:', err.message);
    // Fallback: existing simple PID check
    const running = db.prepare("SELECT id, pid, agent_id FROM queue_items WHERE status = 'running'").all();
    for (const item of running) {
      if (item.pid && !isPidAlive(item.pid)) {
        db.prepare("UPDATE queue_items SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(item.id);
        log(`Reaped stale running item ${item.id} (PID ${item.pid} dead)`);
      }
    }
  }

  // Step 2: Expire old queued items past TTL
  const ttlResult = db.prepare("UPDATE queue_items SET status = 'cancelled', error = 'TTL expired', completed_at = datetime('now') WHERE status = 'queued' AND expires_at < datetime('now')").run();
  if (ttlResult.changes > 0) {
    auditEvent('session_ttl_expired', { count: ttlResult.changes });
  }

  // Step 3: Count running items by lane (suspended items do NOT count toward capacity)
  const standardRunning = db.prepare("SELECT COUNT(*) as cnt FROM queue_items WHERE status = 'running' AND lane != 'gate'").get().cnt;
  const gateRunning = db.prepare("SELECT COUNT(*) as cnt FROM queue_items WHERE status = 'running' AND lane = 'gate'").get().cnt;
  const maxConcurrent = getMaxConcurrentSessions();

  // Step 4: Get queued items ordered by priority then enqueue time
  // Revival lane items first, then gate, then standard
  // cto is the highest priority level (0), followed by critical (1), urgent (2), normal (3), low (4)
  const queued = db.prepare(`
    SELECT * FROM queue_items WHERE status = 'queued'
    ORDER BY
      CASE lane WHEN 'revival' THEN 0 WHEN 'gate' THEN 1 ELSE 2 END,
      CASE priority WHEN 'cto' THEN 0 WHEN 'critical' THEN 1 WHEN 'urgent' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
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
  const standardRunning = db.prepare("SELECT COUNT(*) as cnt FROM queue_items WHERE status = 'running' AND lane != 'gate'").get().cnt;
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
    WHERE status = 'running' AND lane != 'gate' AND priority != 'cto'
    ORDER BY
      CASE priority WHEN 'low' THEN 0 WHEN 'normal' THEN 1
                    WHEN 'urgent' THEN 2 WHEN 'critical' THEN 3 ELSE 4 END,
      spawned_at ASC
    LIMIT 1
  `).get();

  if (!victim) {
    // All running sessions are CTO-priority or gate — cannot preempt
    log(`preemptForCtoTask: no preemptable sessions found (all are CTO-priority or gate)`);
    drainQueue();
    return { preempted: false };
  }

  const pid = victim.pid;
  const agentId = victim.agent_id;

  log(`preemptForCtoTask: preempting ${victim.id} (agent: ${agentId}, PID: ${pid}, priority: ${victim.priority}, title: "${victim.title}")`);

  // Calculate elapsed time for the prompt
  const spawnedAt = victim.spawned_at ? new Date(victim.spawned_at) : new Date();
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
        console.error('[session-queue] Warning: could not parse suspended-sessions.json:', err.message);
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
          console.error('[session-queue] Warning:', err.message);
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
    console.error('[session-queue] Warning: could not parse victim metadata:', err.message);
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
    console.error('[session-queue] Warning: failed to emit audit events:', err.message);
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
    console.error('[session-queue] Warning:', err.message);
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

  return {
    hasData: true,
    maxConcurrent,
    running: activeRunning.length,
    suspended: suspendedItems.length,
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
    suspendedItems: suspendedItems.map(item => ({
      id: item.id,
      title: item.title,
      source: item.source,
      agentType: item.agent_type,
      agentId: item.agent_id,
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
