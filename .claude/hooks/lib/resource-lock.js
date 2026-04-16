/**
 * Resource Lock — SQLite-backed shared resource registry with per-resource locks and queues.
 *
 * Generalizes the display lock into a multi-resource lock module. Any resource can be
 * registered and locked exclusively, with a priority-ordered waiting queue per resource.
 *
 * Backward-compatible wrappers for the old display-lock API are exported at the bottom.
 *
 * DB: .claude/state/display-lock.db (same file as display-lock.js — migrated in getDb())
 *
 * Lock semantics (per resource):
 *   - TTL auto-expiry prevents orphaned locks when holders die
 *   - Holder must call renewResource() every ~5 min to stay alive
 *   - On expiry: checkAndExpireResources() releases and promotes next waiter
 *   - On agent death: session-reaper calls releaseAllResources() immediately
 *
 * @module lib/resource-lock
 * @version 2.0.0
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { auditEvent } from './session-audit.js';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'display-lock.db');
const QUEUE_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'session-queue.db');
const LOG_FILE = path.join(PROJECT_DIR, '.claude', 'session-queue.log');

// Default lock TTL in minutes — holder must renew every ~5 min to stay alive
const DEFAULT_TTL_MINUTES = 15;

// Built-in resources registered on first DB open
const DEFAULT_RESOURCES = [
  { resource_id: 'display', description: 'Headed browser display / ScreenCaptureKit window recording', default_ttl_minutes: 15 },
  { resource_id: 'chrome-bridge', description: 'Real Chrome automation via claude-for-chrome extension', default_ttl_minutes: 15 },
  { resource_id: 'main-dev-server', description: 'Main-tree development server (port 3000)', default_ttl_minutes: 30 },
];

// ============================================================================
// Logging
// ============================================================================

function log(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [resource-lock] ${message}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch (_) {
    // Non-fatal — logging must never crash callers
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

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  // Check whether we're migrating from the old display_lock schema
  const oldTableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='display_lock'"
  ).get();

  if (oldTableExists) {
    // Migration: rename old tables and add resource_id columns
    db.transaction(() => {
      // Step 1: Check if resource_locks already exists (guard against partial migration)
      const newTableExists = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='resource_locks'"
      ).get();

      if (!newTableExists) {
        // Recreate display_lock as resource_locks with the new schema.
        // SQLite doesn't support DROP COLUMN or RENAME COLUMN easily pre-3.35, so we
        // CREATE the new table, copy data, and drop the old one.
        db.exec(`
          CREATE TABLE resource_locks (
            resource_id TEXT PRIMARY KEY,
            holder_agent_id TEXT,
            holder_queue_id TEXT,
            holder_title TEXT,
            acquired_at TEXT,
            expires_at TEXT,
            heartbeat_at TEXT
          );

          -- Copy the single 'global' row as the 'display' resource
          INSERT OR IGNORE INTO resource_locks (resource_id, holder_agent_id, holder_queue_id, holder_title, acquired_at, expires_at, heartbeat_at)
          SELECT 'display', holder_agent_id, holder_queue_id, holder_title, acquired_at, expires_at, heartbeat_at
          FROM display_lock WHERE id = 'global';

          DROP TABLE display_lock;
        `);
      }

      const oldQueueExists = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='display_queue'"
      ).get();

      if (oldQueueExists) {
        const newQueueExists = db.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='resource_queue'"
        ).get();

        if (!newQueueExists) {
          db.exec(`
            CREATE TABLE resource_queue (
              id TEXT PRIMARY KEY,
              resource_id TEXT NOT NULL,
              agent_id TEXT,
              queue_id TEXT,
              title TEXT,
              priority TEXT DEFAULT 'normal',
              enqueued_at TEXT NOT NULL DEFAULT (datetime('now')),
              status TEXT DEFAULT 'waiting'
            );

            INSERT OR IGNORE INTO resource_queue (id, resource_id, agent_id, queue_id, title, priority, enqueued_at, status)
            SELECT id, 'display', agent_id, queue_id, title, priority, enqueued_at, status
            FROM display_queue;

            DROP TABLE display_queue;
          `);
        }
      }
    })();
  }

  // Create tables if they don't exist yet (fresh install or post-migration)
  db.exec(`
    CREATE TABLE IF NOT EXISTS resource_locks (
      resource_id TEXT PRIMARY KEY,
      holder_agent_id TEXT,
      holder_queue_id TEXT,
      holder_title TEXT,
      acquired_at TEXT,
      expires_at TEXT,
      heartbeat_at TEXT
    );

    CREATE TABLE IF NOT EXISTS resource_queue (
      id TEXT PRIMARY KEY,
      resource_id TEXT NOT NULL,
      agent_id TEXT,
      queue_id TEXT,
      title TEXT,
      priority TEXT DEFAULT 'normal',
      enqueued_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT DEFAULT 'waiting'
    );

    CREATE TABLE IF NOT EXISTS resource_registry (
      resource_id TEXT PRIMARY KEY,
      description TEXT,
      default_ttl_minutes INTEGER DEFAULT 15,
      registered_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Seed default resources
  for (const r of DEFAULT_RESOURCES) {
    db.prepare(
      "INSERT OR IGNORE INTO resource_registry (resource_id, description, default_ttl_minutes) VALUES (?, ?, ?)"
    ).run(r.resource_id, r.description, r.default_ttl_minutes);

    // Ensure each registered resource has a lock row (empty = unlocked)
    db.prepare(
      "INSERT OR IGNORE INTO resource_locks (resource_id) VALUES (?)"
    ).run(r.resource_id);
  }

  _db = db;
  return _db;
}

// ============================================================================
// Internal Utilities
// ============================================================================

/**
 * Generate a resource-queue entry ID.
 * @returns {string}
 */
function generateQueueEntryId() {
  return 'rl-' + crypto.randomBytes(4).toString('hex');
}

/**
 * Check if a resource lock row is currently expired.
 * @param {object|null} lock - Row from resource_locks
 * @returns {boolean}
 */
function isLockExpired(lock) {
  if (!lock || !lock.holder_agent_id) return false; // Not held — not "expired"
  if (!lock.expires_at) return false; // No expiry set — never expires (defensive)
  return new Date(lock.expires_at) < new Date();
}

/**
 * Get the TTL for a resource from the registry, falling back to DEFAULT_TTL_MINUTES.
 * @param {object} db
 * @param {string} resourceId
 * @returns {number} TTL in minutes
 */
function getResourceTtl(db, resourceId) {
  const reg = db.prepare("SELECT default_ttl_minutes FROM resource_registry WHERE resource_id = ?").get(resourceId);
  return (reg && reg.default_ttl_minutes) ? reg.default_ttl_minutes : DEFAULT_TTL_MINUTES;
}

/**
 * Check if a PID is alive.
 * @param {number} pid
 * @returns {boolean}
 */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Look up an agent's PID from session-queue.db via their queue_id.
 * Returns null if the queue DB doesn't exist, the entry isn't found, or any error occurs.
 * Fail-open: callers fall through to TTL check when null is returned.
 *
 * @param {string|null} queueId - The queue_id (maps to queue_items.id in session-queue.db)
 * @returns {number|null}
 */
function getAgentPid(queueId) {
  if (!queueId) return null;
  try {
    if (!fs.existsSync(QUEUE_DB_PATH)) return null;
    const qDb = new Database(QUEUE_DB_PATH, { readonly: true });
    qDb.pragma('busy_timeout = 2000');
    try {
      const row = qDb.prepare("SELECT pid FROM queue_items WHERE id = ?").get(queueId);
      return row?.pid ?? null;
    } finally {
      qDb.close();
    }
  } catch (_) {
    return null; // Fail-open
  }
}

/**
 * Promote the next waiting entry from resource_queue for a given resource to lock holder.
 * Skips dead waiters (PID no longer alive) — marks them 'skipped' and tries the next.
 * Must be called inside a transaction.
 * @param {object} db
 * @param {string} resourceId
 * @returns {object|null} The promoted queue entry, or null if queue empty / all dead
 */
function promoteNextWaiter(db, resourceId) {
  const waiters = db.prepare(
    "SELECT * FROM resource_queue WHERE resource_id = ? AND status = 'waiting' ORDER BY " +
    "CASE priority WHEN 'cto' THEN 0 WHEN 'critical' THEN 1 WHEN 'urgent' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END, " +
    "enqueued_at ASC"
  ).all(resourceId);

  for (const next of waiters) {
    // Check if waiter is alive via session-queue PID lookup
    const pid = getAgentPid(next.queue_id);
    if (pid !== null && !isPidAlive(pid)) {
      db.prepare("UPDATE resource_queue SET status = 'skipped' WHERE id = ?").run(next.id);
      log(`Skipped dead waiter: resource_id=${resourceId}, agent_id=${next.agent_id}, pid=${pid}, queue_entry_id=${next.id}`);
      continue;
    }

    // Waiter is alive (or PID unknown — fail-open) — promote
    const ttlMinutes = getResourceTtl(db, resourceId);
    const ttlMs = ttlMinutes * 60 * 1000;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

    db.prepare(
      "UPDATE resource_locks SET holder_agent_id = ?, holder_queue_id = ?, holder_title = ?, " +
      "acquired_at = datetime('now'), expires_at = ?, heartbeat_at = datetime('now') WHERE resource_id = ?"
    ).run(next.agent_id, next.queue_id, next.title, expiresAt, resourceId);

    db.prepare("UPDATE resource_queue SET status = 'acquired' WHERE id = ?").run(next.id);

    log(`Promoted waiter: resource_id=${resourceId}, agent_id=${next.agent_id}, title="${next.title}"`);

    auditEvent('resource_lock_promoted', {
      resource_id: resourceId,
      agent_id: next.agent_id,
      queue_id: next.queue_id,
      title: next.title,
      queue_entry_id: next.id,
    });

    return next;
  }

  return null;
}

/**
 * Clear a resource lock row (no holder, no expiry).
 * Must be called inside a transaction.
 * @param {object} db
 * @param {string} resourceId
 */
function clearLock(db, resourceId) {
  db.prepare(
    "UPDATE resource_locks SET holder_agent_id = NULL, holder_queue_id = NULL, holder_title = NULL, " +
    "acquired_at = NULL, expires_at = NULL, heartbeat_at = NULL WHERE resource_id = ?"
  ).run(resourceId);
}

// ============================================================================
// Core Resource Lock Functions
// ============================================================================

/**
 * Acquire exclusive access to a shared resource.
 *
 * If the lock is free (or expired), acquires immediately and returns
 * { acquired: true }.
 *
 * If the lock is held by another agent, enqueues the caller and returns
 * { acquired: false, position: N, holder: {...}, queue_entry_id: string }.
 *
 * If the caller is already the lock holder, returns { acquired: true } immediately.
 *
 * @param {string} resourceId - ID of the resource to lock (e.g., 'display', 'chrome-bridge')
 * @param {string} agentId - Caller's agent ID (CLAUDE_AGENT_ID)
 * @param {string|null} queueId - Caller's session-queue ID
 * @param {string|null} title - Human-readable description (e.g., "Demo: checkout flow")
 * @param {object} [opts={}]
 * @param {number} [opts.ttlMinutes] - Lock TTL in minutes (defaults to resource registry value)
 * @param {string} [opts.priority='normal'] - Queue priority if lock is held
 * @returns {{ acquired: boolean, position?: number, holder?: object, queue_entry_id?: string }}
 */
export function acquireResource(resourceId, agentId, queueId, title, opts = {}) {
  if (!resourceId) throw new Error('acquireResource: resourceId is required');
  if (!agentId) throw new Error('acquireResource: agentId is required');

  const priority = opts.priority ?? 'normal';
  const db = getDb();

  return db.transaction(() => {
    // Ensure resource lock row exists (auto-create for dynamic resources)
    db.prepare("INSERT OR IGNORE INTO resource_locks (resource_id) VALUES (?)").run(resourceId);

    const lock = db.prepare("SELECT * FROM resource_locks WHERE resource_id = ?").get(resourceId);

    // Use caller-supplied TTL or fall back to registry default
    const ttlMinutes = opts.ttlMinutes ?? getResourceTtl(db, resourceId);

    // Case 1: Caller is already the holder — idempotent success
    if (lock && lock.holder_agent_id === agentId) {
      log(`Already holder: resource_id=${resourceId}, agent_id=${agentId}`);
      return { acquired: true };
    }

    // Case 2: Lock is free or expired — acquire immediately
    const free = !lock || !lock.holder_agent_id;
    const expired = isLockExpired(lock);

    if (free || expired) {
      if (expired) {
        log(`Expired lock detected during acquire — resource_id=${resourceId}, expiry=${lock.expires_at}, releasing for agent_id=${agentId}`);
        auditEvent('resource_lock_expired', {
          resource_id: resourceId,
          prev_holder_agent_id: lock.holder_agent_id,
          prev_holder_title: lock.holder_title,
          expires_at: lock.expires_at,
        });
      }

      const ttlMs = ttlMinutes * 60 * 1000;
      const now = new Date();
      const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

      db.prepare(
        "UPDATE resource_locks SET holder_agent_id = ?, holder_queue_id = ?, holder_title = ?, " +
        "acquired_at = datetime('now'), expires_at = ?, heartbeat_at = datetime('now') WHERE resource_id = ?"
      ).run(agentId, queueId ?? null, title ?? null, expiresAt, resourceId);

      log(`Lock acquired: resource_id=${resourceId}, agent_id=${agentId}, ttl=${ttlMinutes}min, title="${title}"`);

      auditEvent('resource_lock_acquired', {
        resource_id: resourceId,
        agent_id: agentId,
        queue_id: queueId,
        title,
        expires_at: expiresAt,
        was_expired: expired,
      });

      return { acquired: true };
    }

    // Case 3: Lock held by another agent — enqueue caller
    const queueEntryId = generateQueueEntryId();

    db.prepare(
      "INSERT INTO resource_queue (id, resource_id, agent_id, queue_id, title, priority, status) VALUES (?, ?, ?, ?, ?, ?, 'waiting')"
    ).run(queueEntryId, resourceId, agentId, queueId ?? null, title ?? null, priority);

    // Position is count of waiting entries for this resource (excluding just-inserted entry) + 1
    const position = db.prepare(
      "SELECT COUNT(*) as cnt FROM resource_queue WHERE resource_id = ? AND status = 'waiting' AND id != ?"
    ).get(resourceId, queueEntryId).cnt + 1;

    const holder = {
      agent_id: lock.holder_agent_id,
      queue_id: lock.holder_queue_id,
      title: lock.holder_title,
      acquired_at: lock.acquired_at,
      expires_at: lock.expires_at,
    };

    log(`Lock busy — enqueued: resource_id=${resourceId}, agent_id=${agentId}, position=${position}, holder=${lock.holder_agent_id}, queue_entry_id=${queueEntryId}`);

    auditEvent('resource_lock_enqueued', {
      resource_id: resourceId,
      agent_id: agentId,
      queue_id: queueId,
      title,
      queue_entry_id: queueEntryId,
      position,
      holder_agent_id: lock.holder_agent_id,
    });

    return { acquired: false, position, holder, queue_entry_id: queueEntryId };
  })();
}

/**
 * Release the lock on a resource held by agentId.
 *
 * Verifies the caller is the current holder before releasing.
 * Promotes the next waiter from resource_queue if any.
 *
 * @param {string} resourceId - ID of the resource to release
 * @param {string} agentId - Caller's agent ID (must be the current holder)
 * @returns {{ released: boolean, next_holder?: object }}
 */
export function releaseResource(resourceId, agentId) {
  if (!resourceId || !agentId) return { released: false };

  const db = getDb();

  return db.transaction(() => {
    const lock = db.prepare("SELECT * FROM resource_locks WHERE resource_id = ?").get(resourceId);

    if (!lock || !lock.holder_agent_id) {
      // Lock was not held — idempotent no-op
      return { released: false };
    }

    if (lock.holder_agent_id !== agentId) {
      // Caller is not the holder — refuse
      log(`Release refused: resource_id=${resourceId}, caller=${agentId} is NOT holder=${lock.holder_agent_id}`);
      return { released: false };
    }

    auditEvent('resource_lock_released', {
      resource_id: resourceId,
      agent_id: agentId,
      queue_id: lock.holder_queue_id,
      title: lock.holder_title,
      held_since: lock.acquired_at,
    });

    log(`Lock released: resource_id=${resourceId}, agent_id=${agentId}, title="${lock.holder_title}"`);

    // Clear the lock before promoting so promoteNextWaiter can safely overwrite
    clearLock(db, resourceId);

    // Promote next waiter
    const promoted = promoteNextWaiter(db, resourceId);

    return {
      released: true,
      next_holder: promoted ? {
        agent_id: promoted.agent_id,
        queue_id: promoted.queue_id,
        title: promoted.title,
        queue_entry_id: promoted.id,
      } : null,
    };
  })();
}

/**
 * Force-release a resource lock regardless of who holds it.
 *
 * Skips holder verification — use for CTO overrides or when the holder is
 * confirmed dead/stuck and you need to unblock waiting agents immediately
 * instead of waiting for TTL expiry.
 *
 * Also purges dead agents from the waiting queue before promoting.
 *
 * @param {string} resourceId - ID of the resource to force-release
 * @param {string} [reason='cto_override'] - Reason for force-release (logged in audit trail)
 * @returns {{ released: boolean, prev_holder?: object, next_holder?: object, reason: string }}
 */
export function forceReleaseResource(resourceId, reason = 'cto_override') {
  if (!resourceId) return { released: false, reason };

  const db = getDb();

  return db.transaction(() => {
    const lock = db.prepare("SELECT * FROM resource_locks WHERE resource_id = ?").get(resourceId);

    if (!lock || !lock.holder_agent_id) {
      return { released: false, reason, message: 'Resource is not currently locked' };
    }

    const prevHolder = {
      agent_id: lock.holder_agent_id,
      queue_id: lock.holder_queue_id,
      title: lock.holder_title,
      acquired_at: lock.acquired_at,
      expires_at: lock.expires_at,
    };

    auditEvent('resource_lock_force_released', {
      resource_id: resourceId,
      prev_holder_agent_id: lock.holder_agent_id,
      prev_holder_queue_id: lock.holder_queue_id,
      prev_holder_title: lock.holder_title,
      reason,
    });

    log(`Lock force-released: resource_id=${resourceId}, holder=${lock.holder_agent_id}, reason="${reason}"`);

    clearLock(db, resourceId);

    // promoteNextWaiter already skips dead waiters
    const promoted = promoteNextWaiter(db, resourceId);

    return {
      released: true,
      prev_holder: prevHolder,
      next_holder: promoted ? {
        agent_id: promoted.agent_id,
        queue_id: promoted.queue_id,
        title: promoted.title,
        queue_entry_id: promoted.id,
      } : null,
      reason,
    };
  })();
}

/**
 * Force-acquire a resource lock, displacing the current holder.
 *
 * Atomically (single SQLite transaction):
 *   1. Re-enqueues the current holder as a 'waiting' entry (so they get promoted
 *      when the force-acquirer releases).
 *   2. Assigns the lock to the new caller with TTL.
 *
 * Unlike forceReleaseResource + acquireResource, this avoids promoting a waiter
 * in the gap between release and acquire. Designed for CTO-priority preemption.
 *
 * @param {string} resourceId - ID of the resource to force-acquire
 * @param {string} agentId - New holder's agent ID
 * @param {string|null} queueId - New holder's session-queue ID (nullable)
 * @param {string|null} title - Human-readable description
 * @param {object} [opts={}]
 * @param {number} [opts.ttlMinutes] - Lock TTL in minutes (defaults to resource registry value)
 * @param {string} [opts.reEnqueuePriority='urgent'] - Priority for the displaced holder's queue entry
 * @returns {{ acquired: boolean, prev_holder?: object }}
 */
export function forceAcquireResource(resourceId, agentId, queueId, title, opts = {}) {
  if (!resourceId) throw new Error('forceAcquireResource: resourceId is required');
  if (!agentId) throw new Error('forceAcquireResource: agentId is required');

  const reEnqueuePriority = opts.reEnqueuePriority ?? 'urgent';
  const db = getDb();

  return db.transaction(() => {
    // Ensure resource lock row exists
    db.prepare("INSERT OR IGNORE INTO resource_locks (resource_id) VALUES (?)").run(resourceId);

    const lock = db.prepare("SELECT * FROM resource_locks WHERE resource_id = ?").get(resourceId);
    const ttlMinutes = opts.ttlMinutes ?? getResourceTtl(db, resourceId);
    const ttlMs = ttlMinutes * 60 * 1000;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

    let prevHolder = null;

    // If held by someone else, re-enqueue them as a waiter
    if (lock && lock.holder_agent_id && lock.holder_agent_id !== agentId) {
      prevHolder = {
        agent_id: lock.holder_agent_id,
        queue_id: lock.holder_queue_id,
        title: lock.holder_title,
        acquired_at: lock.acquired_at,
      };

      // Re-enqueue displaced holder so they get promoted on release
      const queueEntryId = generateQueueEntryId();
      db.prepare(
        "INSERT INTO resource_queue (id, resource_id, agent_id, queue_id, title, priority, status) VALUES (?, ?, ?, ?, ?, ?, 'waiting')"
      ).run(queueEntryId, resourceId, lock.holder_agent_id, lock.holder_queue_id ?? null, lock.holder_title ?? null, reEnqueuePriority);

      log(`Displaced holder re-enqueued: resource_id=${resourceId}, agent_id=${lock.holder_agent_id}, priority=${reEnqueuePriority}, queue_entry_id=${queueEntryId}`);
    }

    // Assign lock to the new caller
    db.prepare(
      "UPDATE resource_locks SET holder_agent_id = ?, holder_queue_id = ?, holder_title = ?, " +
      "acquired_at = datetime('now'), expires_at = ?, heartbeat_at = datetime('now') WHERE resource_id = ?"
    ).run(agentId, queueId ?? null, title ?? null, expiresAt, resourceId);

    log(`Lock force-acquired: resource_id=${resourceId}, agent_id=${agentId}, ttl=${ttlMinutes}min, title="${title}", prev_holder=${prevHolder?.agent_id ?? 'none'}`);

    auditEvent('resource_lock_force_acquired', {
      resource_id: resourceId,
      agent_id: agentId,
      queue_id: queueId,
      title,
      expires_at: expiresAt,
      prev_holder_agent_id: prevHolder?.agent_id ?? null,
      prev_holder_title: prevHolder?.title ?? null,
    });

    return { acquired: true, prev_holder: prevHolder };
  })();
}

/**
 * Renew the TTL (heartbeat) on a resource lock.
 *
 * The lock holder should call this every ~5 minutes during long sessions
 * to prevent auto-expiry. Returns the new expiry time.
 *
 * @param {string} resourceId - ID of the resource
 * @param {string} agentId - Caller's agent ID (must be the current holder)
 * @param {number} [ttlMinutes] - New TTL from now (defaults to resource registry value)
 * @returns {{ renewed: boolean, expires_at?: string }}
 */
export function renewResource(resourceId, agentId, ttlMinutes) {
  if (!resourceId || !agentId) return { renewed: false };

  const db = getDb();

  return db.transaction(() => {
    const lock = db.prepare("SELECT * FROM resource_locks WHERE resource_id = ?").get(resourceId);

    if (!lock || lock.holder_agent_id !== agentId) {
      log(`Renew refused: resource_id=${resourceId}, caller=${agentId} is NOT holder=${lock ? lock.holder_agent_id : 'none'}`);
      return { renewed: false };
    }

    const effectiveTtl = ttlMinutes ?? getResourceTtl(db, resourceId);
    const ttlMs = effectiveTtl * 60 * 1000;
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();

    db.prepare(
      "UPDATE resource_locks SET expires_at = ?, heartbeat_at = datetime('now') WHERE resource_id = ?"
    ).run(expiresAt, resourceId);

    log(`Lock renewed: resource_id=${resourceId}, agent_id=${agentId}, new expires_at=${expiresAt}`);

    auditEvent('resource_lock_renewed', {
      resource_id: resourceId,
      agent_id: agentId,
      expires_at: expiresAt,
    });

    return { renewed: true, expires_at: expiresAt };
  })();
}

/**
 * Get the current lock status and queue contents for a resource.
 *
 * If resourceId is null or undefined, returns status for ALL resources.
 *
 * @param {string|null} [resourceId] - ID of the resource, or null/undefined for all
 * @returns {object|object[]} Single resource status object, or array of all resource statuses
 */
export function getResourceStatus(resourceId) {
  const db = getDb();

  if (resourceId == null) {
    // Return all resources
    const allLocks = db.prepare("SELECT * FROM resource_locks").all();
    return allLocks.map(lock => buildResourceStatusObject(db, lock));
  }

  const lock = db.prepare("SELECT * FROM resource_locks WHERE resource_id = ?").get(resourceId);

  if (!lock) {
    return {
      resource_id: resourceId,
      locked: false,
      holder: null,
      expires_at: null,
      queue: [],
    };
  }

  return buildResourceStatusObject(db, lock);
}

/**
 * Build a status object for a single resource lock row.
 * @param {object} db
 * @param {object} lock - Row from resource_locks
 * @returns {object}
 */
function buildResourceStatusObject(db, lock) {
  const queue = db.prepare(
    "SELECT id, agent_id, queue_id, title, priority, enqueued_at, status " +
    "FROM resource_queue WHERE resource_id = ? AND status = 'waiting' ORDER BY " +
    "CASE priority WHEN 'cto' THEN 0 WHEN 'critical' THEN 1 WHEN 'urgent' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END, " +
    "enqueued_at ASC"
  ).all(lock.resource_id);

  const expired = isLockExpired(lock);
  const locked = !!(lock.holder_agent_id && !expired);

  return {
    resource_id: lock.resource_id,
    locked,
    holder: locked ? {
      agent_id: lock.holder_agent_id,
      queue_id: lock.holder_queue_id,
      title: lock.holder_title,
      acquired_at: lock.acquired_at,
      expires_at: lock.expires_at,
      heartbeat_at: lock.heartbeat_at,
    } : null,
    expires_at: locked ? lock.expires_at : null,
    queue: queue.map((entry, i) => ({
      position: i + 1,
      id: entry.id,
      agent_id: entry.agent_id,
      queue_id: entry.queue_id,
      title: entry.title,
      priority: entry.priority,
      enqueued_at: entry.enqueued_at,
    })),
  };
}

/**
 * Check ALL resource locks for expiry and auto-release any that have expired.
 *
 * Called from drainQueue() and hourly automation.
 * Safe to call frequently — no-ops when nothing is expired.
 *
 * @returns {Array<{ resource_id: string, expired: boolean, prev_holder: object, next_holder: object|null }>}
 */
export function checkAndExpireResources() {
  const db = getDb();

  return db.transaction(() => {
    const allLocks = db.prepare("SELECT * FROM resource_locks WHERE holder_agent_id IS NOT NULL").all();
    const results = [];

    for (const lock of allLocks) {
      // Fast-path: check if holder PID is dead before waiting for TTL
      const holderPid = getAgentPid(lock.holder_queue_id);
      const holderDead = holderPid !== null && !isPidAlive(holderPid);

      if (!holderDead && !isLockExpired(lock)) continue;

      const releaseReason = holderDead ? 'holder_dead' : 'ttl_expired';

      log(`Lock ${releaseReason} — auto-releasing: resource_id=${lock.resource_id}, holder=${lock.holder_agent_id}, pid=${holderPid ?? 'unknown'}, expired_at=${lock.expires_at}`);

      auditEvent('resource_lock_expired', {
        resource_id: lock.resource_id,
        holder_agent_id: lock.holder_agent_id,
        holder_queue_id: lock.holder_queue_id,
        holder_title: lock.holder_title,
        expires_at: lock.expires_at,
        auto_released: true,
        release_reason: releaseReason,
        holder_pid: holderPid,
      });

      clearLock(db, lock.resource_id);

      const promoted = promoteNextWaiter(db, lock.resource_id);

      results.push({
        resource_id: lock.resource_id,
        expired: true,
        release_reason: releaseReason,
        prev_holder: {
          agent_id: lock.holder_agent_id,
          title: lock.holder_title,
        },
        next_holder: promoted ? {
          agent_id: promoted.agent_id,
          queue_id: promoted.queue_id,
          title: promoted.title,
          queue_entry_id: promoted.id,
        } : null,
      });
    }

    // Sweep: purge dead waiters from all resource queues proactively.
    // This catches orphaned entries where the agent was reaped from session-queue
    // but its resource_queue entry was never cleaned up (e.g., agent revived with
    // a new ID, leaving the old queue entry behind).
    const allWaiters = db.prepare(
      "SELECT id, resource_id, agent_id, queue_id FROM resource_queue WHERE status = 'waiting'"
    ).all();

    for (const waiter of allWaiters) {
      const pid = getAgentPid(waiter.queue_id);
      if (pid !== null && !isPidAlive(pid)) {
        db.prepare("UPDATE resource_queue SET status = 'skipped' WHERE id = ?").run(waiter.id);
        log(`Swept dead waiter from queue: resource_id=${waiter.resource_id}, agent_id=${waiter.agent_id}, pid=${pid}, queue_entry_id=${waiter.id}`);
      }
    }

    return results;
  })();
}

/**
 * Release ALL resource locks held by the given agent.
 * Called by the session reaper when an agent dies.
 *
 * @param {string} agentId
 * @returns {{ released: string[] }} Array of resource IDs that were released
 */
export function releaseAllResources(agentId) {
  if (!agentId) return { released: [] };

  const db = getDb();

  return db.transaction(() => {
    const held = db.prepare(
      "SELECT resource_id FROM resource_locks WHERE holder_agent_id = ?"
    ).all(agentId);

    const released = [];
    for (const row of held) {
      clearLock(db, row.resource_id);
      promoteNextWaiter(db, row.resource_id);

      auditEvent('resource_lock_released', {
        resource_id: row.resource_id,
        agent_id: agentId,
        reason: 'agent_death',
      });

      log(`Lock force-released (agent death): resource_id=${row.resource_id}, agent_id=${agentId}`);
      released.push(row.resource_id);
    }

    return { released };
  })();
}

/**
 * Remove all waiting queue entries for a dead agent across ALL resources.
 * Called by the session reaper alongside releaseAllResources().
 *
 * @param {string} agentId
 * @returns {{ removed: number }}
 */
export function removeFromAllQueues(agentId) {
  if (!agentId) return { removed: 0 };

  const db = getDb();
  const result = db.prepare(
    "DELETE FROM resource_queue WHERE agent_id = ? AND status = 'waiting'"
  ).run(agentId);

  if (result.changes > 0) {
    log(`Removed ${result.changes} waiting queue entries for dead agent ${agentId} across all resources`);
  }

  return { removed: result.changes };
}

/**
 * Register a new resource in the registry.
 *
 * Idempotent — calling again updates the description/TTL.
 * Also ensures a resource_locks row exists for the new resource.
 *
 * @param {string} resourceId - Unique resource identifier
 * @param {string} description - Human-readable description
 * @param {number} [defaultTtlMinutes=15] - Default lock TTL in minutes
 * @returns {{ registered: boolean, resource_id: string }}
 */
export function registerResource(resourceId, description, defaultTtlMinutes = DEFAULT_TTL_MINUTES) {
  if (!resourceId) throw new Error('registerResource: resourceId is required');

  const db = getDb();

  db.prepare(
    "INSERT INTO resource_registry (resource_id, description, default_ttl_minutes) " +
    "VALUES (?, ?, ?) " +
    "ON CONFLICT(resource_id) DO UPDATE SET description = excluded.description, default_ttl_minutes = excluded.default_ttl_minutes"
  ).run(resourceId, description ?? null, defaultTtlMinutes);

  // Ensure a lock row exists (empty = unlocked)
  db.prepare("INSERT OR IGNORE INTO resource_locks (resource_id) VALUES (?)").run(resourceId);

  log(`Resource registered: resource_id=${resourceId}, ttl=${defaultTtlMinutes}min`);

  return { registered: true, resource_id: resourceId };
}

/**
 * List all resources in the registry.
 *
 * @returns {Array<{ resource_id: string, description: string, default_ttl_minutes: number, registered_at: string }>}
 */
export function listRegisteredResources() {
  const db = getDb();
  return db.prepare("SELECT resource_id, description, default_ttl_minutes, registered_at FROM resource_registry ORDER BY registered_at ASC").all();
}

// ============================================================================
// Backward-Compatibility Wrappers (display-lock.js API)
// ============================================================================

/**
 * Acquire exclusive display access for headed demos or real Chrome usage.
 * Backward-compat wrapper — delegates to acquireResource('display', ...).
 *
 * @param {string} agentId
 * @param {string} queueId
 * @param {string} title
 * @param {object} [opts={}]
 * @returns {{ acquired: boolean, position?: number, holder?: object, queue_entry_id?: string }}
 */
export function acquireDisplayLock(agentId, queueId, title, opts = {}) {
  const result = acquireResource('display', agentId, queueId, title, opts);

  // Emit legacy audit events for existing consumers
  if (result.acquired) {
    auditEvent('display_lock_acquired', {
      agent_id: agentId,
      queue_id: queueId,
      title,
      via_resource_lock: true,
    });
  } else {
    auditEvent('display_lock_enqueued', {
      agent_id: agentId,
      queue_id: queueId,
      title,
      position: result.position,
      holder_agent_id: result.holder?.agent_id,
      queue_entry_id: result.queue_entry_id,
      via_resource_lock: true,
    });
  }

  return result;
}

/**
 * Release the display lock held by agentId.
 * Backward-compat wrapper — delegates to releaseResource('display', agentId).
 *
 * @param {string} agentId
 * @returns {{ released: boolean, next_holder?: object }}
 */
export function releaseDisplayLock(agentId) {
  const result = releaseResource('display', agentId);

  if (result.released) {
    auditEvent('display_lock_released', {
      agent_id: agentId,
      via_resource_lock: true,
    });
  }

  return result;
}

/**
 * Renew the display lock TTL (heartbeat).
 * Backward-compat wrapper — delegates to renewResource('display', agentId, ttlMinutes).
 *
 * @param {string} agentId
 * @param {number} [ttlMinutes=15]
 * @returns {{ renewed: boolean, expires_at?: string }}
 */
export function renewDisplayLock(agentId, ttlMinutes = DEFAULT_TTL_MINUTES) {
  const result = renewResource('display', agentId, ttlMinutes);

  if (result.renewed) {
    auditEvent('display_lock_renewed', {
      agent_id: agentId,
      expires_at: result.expires_at,
      via_resource_lock: true,
    });
  }

  return result;
}

/**
 * Get the current display lock status and queue.
 * Backward-compat wrapper — delegates to getResourceStatus('display').
 *
 * @returns {{ locked: boolean, holder?: object, queue: Array, expires_at?: string }}
 */
export function getDisplayLockStatus() {
  const status = getResourceStatus('display');

  // Keep old field shape for callers expecting the display-lock schema
  return {
    locked: status.locked,
    holder: status.holder,
    expires_at: status.expires_at,
    queue: status.queue,
  };
}

/**
 * Check for expired display lock and release it, promoting the next waiter.
 * Backward-compat wrapper — delegates to checkAndExpireResources() but only
 * returns the display resource result in the old single-object shape.
 *
 * @returns {{ expired: boolean, prev_holder?: object, next_holder?: object }}
 */
export function checkAndExpireLock() {
  const results = checkAndExpireResources();
  const displayResult = results.find(r => r.resource_id === 'display');

  if (!displayResult) {
    return { expired: false };
  }

  // Emit legacy audit event for existing consumers
  auditEvent('display_lock_expired', {
    holder_agent_id: displayResult.prev_holder?.agent_id,
    holder_title: displayResult.prev_holder?.title,
    auto_released: true,
    via_resource_lock: true,
  });

  return {
    expired: displayResult.expired,
    prev_holder: displayResult.prev_holder,
    next_holder: displayResult.next_holder,
  };
}

/**
 * Remove a dead agent's waiting entries from the display queue.
 * Backward-compat wrapper — delegates to removeFromAllQueues(agentId).
 *
 * NOTE: This now removes the agent from ALL resource queues, not just display.
 * This is intentional — a dead agent should not hold positions in any queue.
 *
 * @param {string} agentId
 * @returns {{ removed: number }}
 */
export function removeFromDisplayQueue(agentId) {
  return removeFromAllQueues(agentId);
}
