/**
 * Display Lock — SQLite-backed exclusive display access lock with queue.
 *
 * Serializes access to headed Playwright demos, real Chrome (chrome-bridge),
 * and any future display-requiring tool. Prevents concurrent window capture
 * conflicts and corrupted video recordings.
 *
 * DB: .claude/state/display-lock.db (WAL mode)
 *
 * Lock semantics:
 *   - Single global lock (id = 'global')
 *   - TTL auto-expiry to prevent orphaned locks when holders die
 *   - Holder must call renewDisplayLock() every ~5 min to stay alive
 *   - On expiry: checkAndExpireLock() releases and promotes next waiter
 *   - On agent death: session-reaper calls releaseDisplayLock() immediately
 *
 * @module lib/display-lock
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { auditEvent } from './session-audit.js';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'display-lock.db');
const LOG_FILE = path.join(PROJECT_DIR, '.claude', 'session-queue.log');

// Default lock TTL in minutes — holder must renew every ~5 min to stay alive
const DEFAULT_TTL_MINUTES = 15;

// ============================================================================
// Logging
// ============================================================================

function log(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [display-lock] ${message}\n`;
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

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('busy_timeout = 5000');

  // Initialize schema
  _db.exec(`
    CREATE TABLE IF NOT EXISTS display_lock (
      id TEXT PRIMARY KEY DEFAULT 'global',
      holder_agent_id TEXT,
      holder_queue_id TEXT,
      holder_title TEXT,
      acquired_at TEXT,
      expires_at TEXT,
      heartbeat_at TEXT
    );

    CREATE TABLE IF NOT EXISTS display_queue (
      id TEXT PRIMARY KEY,
      agent_id TEXT,
      queue_id TEXT,
      title TEXT,
      priority TEXT DEFAULT 'normal',
      enqueued_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT DEFAULT 'waiting'
    );

    -- Ensure the global lock row exists (upsert on first use)
    INSERT OR IGNORE INTO display_lock (id) VALUES ('global');
  `);

  return _db;
}

// ============================================================================
// Internal Utilities
// ============================================================================

/**
 * Generate a display-queue entry ID.
 * @returns {string}
 */
function generateQueueEntryId() {
  return 'dl-' + crypto.randomBytes(4).toString('hex');
}

/**
 * Check if the global lock is currently expired.
 * @param {object} lock - Row from display_lock
 * @returns {boolean}
 */
function isLockExpired(lock) {
  if (!lock || !lock.holder_agent_id) return false; // Not held — not "expired"
  if (!lock.expires_at) return false; // No expiry set — never expires (defensive)
  return new Date(lock.expires_at) < new Date();
}

/**
 * Promote the next waiting entry from display_queue to lock holder.
 * Must be called inside a transaction.
 * @param {object} db
 * @returns {object|null} The promoted queue entry, or null if queue empty
 */
function promoteNextWaiter(db) {
  const next = db.prepare(
    "SELECT * FROM display_queue WHERE status = 'waiting' ORDER BY " +
    "CASE priority WHEN 'cto' THEN 0 WHEN 'critical' THEN 1 WHEN 'urgent' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END, " +
    "enqueued_at ASC LIMIT 1"
  ).get();

  if (!next) return null;

  const ttlMs = DEFAULT_TTL_MINUTES * 60 * 1000;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

  db.prepare(
    "UPDATE display_lock SET holder_agent_id = ?, holder_queue_id = ?, holder_title = ?, " +
    "acquired_at = datetime('now'), expires_at = ?, heartbeat_at = datetime('now') WHERE id = 'global'"
  ).run(next.agent_id, next.queue_id, next.title, expiresAt);

  db.prepare("UPDATE display_queue SET status = 'acquired' WHERE id = ?").run(next.id);

  log(`Promoted waiter: agent_id=${next.agent_id}, title="${next.title}"`);

  auditEvent('display_lock_promoted', {
    agent_id: next.agent_id,
    queue_id: next.queue_id,
    title: next.title,
    queue_entry_id: next.id,
  });

  return next;
}

/**
 * Clear the global lock row (no holder, no expiry).
 * Must be called inside a transaction.
 * @param {object} db
 */
function clearLock(db) {
  db.prepare(
    "UPDATE display_lock SET holder_agent_id = NULL, holder_queue_id = NULL, holder_title = NULL, " +
    "acquired_at = NULL, expires_at = NULL, heartbeat_at = NULL WHERE id = 'global'"
  ).run();
}

// ============================================================================
// Exported Functions
// ============================================================================

/**
 * Acquire exclusive display access for headed demos or real Chrome usage.
 *
 * If the lock is free (or expired), acquires immediately and returns
 * { acquired: true }.
 *
 * If the lock is held by another agent, enqueues the caller and returns
 * { acquired: false, position: N, holder: {...}, queue_entry_id: string }.
 *
 * If the caller is already the lock holder, returns { acquired: true } immediately.
 *
 * @param {string} agentId - Caller's agent ID (CLAUDE_AGENT_ID)
 * @param {string} queueId - Caller's session-queue ID
 * @param {string} title - Human-readable description (e.g., "Demo: checkout flow")
 * @param {object} [opts={}]
 * @param {number} [opts.ttlMinutes=15] - Lock TTL in minutes
 * @param {string} [opts.priority='normal'] - Queue priority if lock is held
 * @returns {{ acquired: boolean, position?: number, holder?: object, queue_entry_id?: string }}
 */
export function acquireDisplayLock(agentId, queueId, title, opts = {}) {
  if (!agentId) throw new Error('acquireDisplayLock: agentId is required');

  const ttlMinutes = opts.ttlMinutes ?? DEFAULT_TTL_MINUTES;
  const priority = opts.priority ?? 'normal';

  const db = getDb();

  return db.transaction(() => {
    const lock = db.prepare("SELECT * FROM display_lock WHERE id = 'global'").get();

    // Case 1: Caller is already the holder — idempotent success
    if (lock && lock.holder_agent_id === agentId) {
      log(`Already holder: agent_id=${agentId}`);
      return { acquired: true };
    }

    // Case 2: Lock is free or expired — acquire immediately
    const free = !lock || !lock.holder_agent_id;
    const expired = isLockExpired(lock);

    if (free || expired) {
      if (expired) {
        log(`Expired lock detected during acquire — expiry=${lock.expires_at}, releasing for agent_id=${agentId}`);
        auditEvent('display_lock_expired', {
          prev_holder_agent_id: lock.holder_agent_id,
          prev_holder_title: lock.holder_title,
          expires_at: lock.expires_at,
        });
      }

      const ttlMs = ttlMinutes * 60 * 1000;
      const now = new Date();
      const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

      db.prepare(
        "UPDATE display_lock SET holder_agent_id = ?, holder_queue_id = ?, holder_title = ?, " +
        "acquired_at = datetime('now'), expires_at = ?, heartbeat_at = datetime('now') WHERE id = 'global'"
      ).run(agentId, queueId ?? null, title ?? null, expiresAt);

      log(`Lock acquired: agent_id=${agentId}, ttl=${ttlMinutes}min, title="${title}"`);

      auditEvent('display_lock_acquired', {
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
      "INSERT INTO display_queue (id, agent_id, queue_id, title, priority, status) VALUES (?, ?, ?, ?, ?, 'waiting')"
    ).run(queueEntryId, agentId, queueId ?? null, title ?? null, priority);

    // Position is count of waiting entries with earlier enqueue time or higher priority
    // (Use entry count before this insert + 1 for simplicity — the new row is at the end of its priority tier)
    const position = db.prepare(
      "SELECT COUNT(*) as cnt FROM display_queue WHERE status = 'waiting' AND id != ?"
    ).get(queueEntryId).cnt + 1;

    const holder = {
      agent_id: lock.holder_agent_id,
      queue_id: lock.holder_queue_id,
      title: lock.holder_title,
      acquired_at: lock.acquired_at,
      expires_at: lock.expires_at,
    };

    log(`Lock busy — enqueued: agent_id=${agentId}, position=${position}, holder=${lock.holder_agent_id}, queue_entry_id=${queueEntryId}`);

    auditEvent('display_lock_enqueued', {
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
 * Release the display lock held by agentId.
 *
 * Verifies the caller is the current holder before releasing.
 * Promotes the next waiter from display_queue if any.
 *
 * @param {string} agentId - Caller's agent ID
 * @returns {{ released: boolean, next_holder?: object }}
 */
export function releaseDisplayLock(agentId) {
  if (!agentId) return { released: false };

  const db = getDb();

  return db.transaction(() => {
    const lock = db.prepare("SELECT * FROM display_lock WHERE id = 'global'").get();

    if (!lock || !lock.holder_agent_id) {
      // Lock was not held — idempotent no-op (suppress log — this fires on every
      // dead agent reap, most of which never held the display lock)
      return { released: false };
    }

    if (lock.holder_agent_id !== agentId) {
      // Caller is not the holder — refuse (fail loudly in log, return false)
      log(`Release refused: caller=${agentId} is NOT holder=${lock.holder_agent_id}`);
      return { released: false };
    }

    auditEvent('display_lock_released', {
      agent_id: agentId,
      queue_id: lock.holder_queue_id,
      title: lock.holder_title,
      held_since: lock.acquired_at,
    });

    log(`Lock released: agent_id=${agentId}, title="${lock.holder_title}"`);

    // Clear the lock before promoting so promoteNextWaiter can safely overwrite
    clearLock(db);

    // Promote next waiter
    const promoted = promoteNextWaiter(db);

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
 * Renew the display lock TTL (heartbeat).
 *
 * The lock holder should call this every ~5 minutes during long demo sessions
 * to prevent auto-expiry. Returns the new expiry time.
 *
 * @param {string} agentId - Caller's agent ID (must be the current holder)
 * @param {number} [ttlMinutes=15] - New TTL from now
 * @returns {{ renewed: boolean, expires_at?: string }}
 */
export function renewDisplayLock(agentId, ttlMinutes = DEFAULT_TTL_MINUTES) {
  if (!agentId) return { renewed: false };

  const db = getDb();

  return db.transaction(() => {
    const lock = db.prepare("SELECT * FROM display_lock WHERE id = 'global'").get();

    if (!lock || lock.holder_agent_id !== agentId) {
      log(`Renew refused: caller=${agentId} is NOT holder=${lock ? lock.holder_agent_id : 'none'}`);
      return { renewed: false };
    }

    const ttlMs = ttlMinutes * 60 * 1000;
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();

    db.prepare(
      "UPDATE display_lock SET expires_at = ?, heartbeat_at = datetime('now') WHERE id = 'global'"
    ).run(expiresAt);

    log(`Lock renewed: agent_id=${agentId}, new expires_at=${expiresAt}`);

    auditEvent('display_lock_renewed', {
      agent_id: agentId,
      expires_at: expiresAt,
    });

    return { renewed: true, expires_at: expiresAt };
  })();
}

/**
 * Get the current display lock status and full queue contents.
 *
 * Used by the MCP tool and by agents deciding whether to run headed or headless.
 *
 * @returns {{ locked: boolean, holder?: object, queue: Array, expires_at?: string }}
 */
export function getDisplayLockStatus() {
  const db = getDb();

  const lock = db.prepare("SELECT * FROM display_lock WHERE id = 'global'").get();
  const queue = db.prepare(
    "SELECT id, agent_id, queue_id, title, priority, enqueued_at, status FROM display_queue WHERE status = 'waiting' ORDER BY " +
    "CASE priority WHEN 'cto' THEN 0 WHEN 'critical' THEN 1 WHEN 'urgent' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END, " +
    "enqueued_at ASC"
  ).all();

  const expired = isLockExpired(lock);
  const locked = !!(lock && lock.holder_agent_id && !expired);

  return {
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
 * Check for an expired display lock and release it, promoting the next waiter.
 *
 * Called from drainQueue() and hourly automation.
 * Safe to call frequently — no-ops if lock is not expired.
 *
 * @returns {{ expired: boolean, next_holder?: object }}
 */
/**
 * Remove a dead agent's waiting entries from the display queue.
 * Called by the session reaper alongside releaseDisplayLock() to prevent
 * dead agents from being promoted to lock holder.
 *
 * @param {string} agentId
 * @returns {{ removed: number }}
 */
export function removeFromDisplayQueue(agentId) {
  if (!agentId) return { removed: 0 };
  const db = getDb();
  const result = db.prepare("DELETE FROM display_queue WHERE agent_id = ? AND status = 'waiting'").run(agentId);
  if (result.changes > 0) {
    log(`Removed ${result.changes} waiting queue entries for dead agent ${agentId}`);
  }
  return { removed: result.changes };
}

/**
 * Check if the display lock has expired and auto-release if so.
 *
 * @returns {{ expired: boolean, next_holder?: object }}
 */
export function checkAndExpireLock() {
  const db = getDb();

  return db.transaction(() => {
    const lock = db.prepare("SELECT * FROM display_lock WHERE id = 'global'").get();

    if (!isLockExpired(lock)) {
      return { expired: false };
    }

    log(`Lock expired — auto-releasing: holder=${lock.holder_agent_id}, expired_at=${lock.expires_at}`);

    auditEvent('display_lock_expired', {
      holder_agent_id: lock.holder_agent_id,
      holder_queue_id: lock.holder_queue_id,
      holder_title: lock.holder_title,
      expires_at: lock.expires_at,
      auto_released: true,
    });

    clearLock(db);

    const promoted = promoteNextWaiter(db);

    return {
      expired: true,
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
    };
  })();
}
