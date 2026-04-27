/**
 * Deferred Protected Action Database Operations
 *
 * Manages the lifecycle of deferred protected actions — MCP tool calls
 * that spawned agents requested but require CTO approval before execution.
 * Actions are stored persistently and executed automatically when approved,
 * regardless of whether the requesting agent is still alive.
 *
 * DB: .claude/state/bypass-requests.db (shared with bypass_requests table)
 * Table: deferred_actions
 *
 * @module lib/deferred-action-db
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const BYPASS_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'bypass-requests.db');

// Lazy SQLite — top-level await matches pattern used by bypass-guard.js
let Database = null;
try {
  Database = (await import('better-sqlite3')).default;
} catch (_) {
  // SQLite unavailable — openDb() returns null
}

// ============================================================================
// Database Initialization
// ============================================================================

/**
 * Open the bypass-requests.db and ensure the deferred_actions table exists.
 * @param {object} [opts] - Options
 * @param {boolean} [opts.readonly] - Open in readonly mode
 * @returns {object|null} Database instance or null on failure
 */
export function openDb(opts = {}) {
  if (!Database) return null;
  try {
    const stateDir = path.dirname(BYPASS_DB_PATH);
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }

    const db = new Database(BYPASS_DB_PATH, {
      ...(opts.readonly && { readonly: true }),
    });
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 3000');

    if (!opts.readonly) {
      migrate(db);
    }

    return db;
  } catch (err) {
    // Non-fatal — caller handles null
    return null;
  }
}

/**
 * Run migrations to create/update the deferred_actions table.
 * @param {object} db - better-sqlite3 instance
 */
function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS deferred_actions (
      id TEXT PRIMARY KEY,
      server TEXT NOT NULL,
      tool TEXT NOT NULL,
      args TEXT NOT NULL,
      args_hash TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE,
      phrase TEXT NOT NULL,
      pending_hmac TEXT NOT NULL,
      approved_hmac TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      requester_agent_id TEXT,
      requester_session_id TEXT,
      requester_task_type TEXT,
      requester_task_id TEXT,
      execution_result TEXT,
      execution_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      approved_at TEXT,
      executed_at TEXT,
      expires_at TEXT,
      CHECK (status IN ('pending', 'approved', 'executing', 'completed', 'failed', 'expired', 'cancelled'))
    );
    CREATE INDEX IF NOT EXISTS idx_deferred_status ON deferred_actions(status);
    CREATE INDEX IF NOT EXISTS idx_deferred_code ON deferred_actions(code);
  `);
}

// ============================================================================
// CRUD Operations
// ============================================================================

/**
 * Create a deferred action record.
 * @param {object} db - better-sqlite3 instance
 * @param {object} params
 * @param {string} params.server - MCP server name
 * @param {string} params.tool - Tool name
 * @param {object} params.args - Tool arguments (stored as JSON)
 * @param {string} params.argsHash - SHA256 hash of JSON-stringified args
 * @param {string} params.code - 6-char approval code
 * @param {string} params.phrase - Approval phrase (e.g., "APPROVE DEPLOY")
 * @param {string} params.pendingHmac - HMAC signature of the pending request
 * @param {string} [params.requesterAgentId] - Agent that requested the action
 * @param {string} [params.requesterSessionId] - Session that requested the action
 * @param {string} [params.requesterTaskType] - 'persistent' or 'todo'
 * @param {string} [params.requesterTaskId] - Task ID
 * @param {string} [params.expiresAt] - ISO timestamp for expiry (null = no expiry)
 * @returns {object} The created record
 */
export function createDeferredAction(db, params) {
  const id = `deferred-${crypto.randomBytes(6).toString('hex')}`;

  db.prepare(`
    INSERT INTO deferred_actions (
      id, server, tool, args, args_hash, code, phrase, pending_hmac,
      requester_agent_id, requester_session_id, requester_task_type,
      requester_task_id, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    params.server,
    params.tool,
    JSON.stringify(params.args),
    params.argsHash,
    params.code,
    params.phrase,
    params.pendingHmac,
    params.requesterAgentId || null,
    params.requesterSessionId || null,
    params.requesterTaskType || null,
    params.requesterTaskId || null,
    params.expiresAt || null,
  );

  return { id, code: params.code, server: params.server, tool: params.tool };
}

/**
 * Get a deferred action by its 6-char code.
 * @param {object} db - better-sqlite3 instance
 * @param {string} code - 6-char approval code (case-insensitive)
 * @returns {object|null} Action record or null
 */
export function getDeferredActionByCode(db, code) {
  const row = db.prepare('SELECT * FROM deferred_actions WHERE code = ?').get(code.toUpperCase());
  if (row && row.args) {
    try { row.args = JSON.parse(row.args); } catch { /* leave as string */ }
  }
  return row || null;
}

/**
 * Get a deferred action by ID.
 * @param {object} db - better-sqlite3 instance
 * @param {string} id - Action ID
 * @returns {object|null} Action record or null
 */
export function getDeferredAction(db, id) {
  const row = db.prepare('SELECT * FROM deferred_actions WHERE id = ?').get(id);
  if (row && row.args) {
    try { row.args = JSON.parse(row.args); } catch { /* leave as string */ }
  }
  return row || null;
}

/**
 * List pending deferred actions (for session briefing).
 * @param {object} db - better-sqlite3 instance
 * @returns {object[]} List of pending actions
 */
export function listPendingDeferredActions(db) {
  const rows = db.prepare(
    "SELECT * FROM deferred_actions WHERE status = 'pending' ORDER BY created_at ASC"
  ).all();

  for (const row of rows) {
    if (row.args) {
      try { row.args = JSON.parse(row.args); } catch { /* leave as string */ }
    }
  }
  return rows;
}

/**
 * Mark a deferred action as approved.
 * @param {object} db - better-sqlite3 instance
 * @param {string} id - Action ID
 * @param {string} approvedHmac - HMAC of the approval
 * @returns {boolean} true if updated
 */
export function markApproved(db, id, approvedHmac) {
  const result = db.prepare(
    "UPDATE deferred_actions SET status = 'approved', approved_hmac = ?, approved_at = datetime('now') WHERE id = ? AND status = 'pending'"
  ).run(approvedHmac, id);
  return result.changes > 0;
}

/**
 * Mark a deferred action as executing (prevents double-execution).
 * @param {object} db - better-sqlite3 instance
 * @param {string} id - Action ID
 * @returns {boolean} true if status was atomically transitioned
 */
export function markExecuting(db, id) {
  const result = db.prepare(
    "UPDATE deferred_actions SET status = 'executing' WHERE id = ? AND status = 'approved'"
  ).run(id);
  return result.changes > 0;
}

/**
 * Mark a deferred action as completed with execution result.
 * @param {object} db - better-sqlite3 instance
 * @param {string} id - Action ID
 * @param {string} result - JSON-stringified execution result
 */
export function markCompleted(db, id, result) {
  db.prepare(
    "UPDATE deferred_actions SET status = 'completed', execution_result = ?, executed_at = datetime('now') WHERE id = ?"
  ).run(result, id);
}

/**
 * Mark a deferred action as failed with error details.
 * @param {object} db - better-sqlite3 instance
 * @param {string} id - Action ID
 * @param {string} error - Error description
 */
export function markFailed(db, id, error) {
  db.prepare(
    "UPDATE deferred_actions SET status = 'failed', execution_error = ?, executed_at = datetime('now') WHERE id = ?"
  ).run(error, id);
}

/**
 * Cancel a pending deferred action.
 * @param {object} db - better-sqlite3 instance
 * @param {string} id - Action ID
 * @returns {boolean} true if cancelled
 */
export function cancelAction(db, id) {
  const result = db.prepare(
    "UPDATE deferred_actions SET status = 'cancelled' WHERE id = ? AND status = 'pending'"
  ).run(id);
  return result.changes > 0;
}

/**
 * Expire stale deferred actions past their expires_at.
 * Called during maintenance. Actions with null expires_at never expire.
 * @param {object} db - better-sqlite3 instance
 * @returns {number} Number of actions expired
 */
export function expireStaleActions(db) {
  const result = db.prepare(
    "UPDATE deferred_actions SET status = 'expired' WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < datetime('now')"
  ).run();
  return result.changes;
}

/**
 * Check for an existing pending deferred action with matching server+tool+argsHash.
 * Prevents duplicate requests for the same action.
 * @param {object} db - better-sqlite3 instance
 * @param {string} server
 * @param {string} tool
 * @param {string} argsHash
 * @returns {object|null} Existing pending action or null
 */
export function findDuplicatePending(db, server, tool, argsHash) {
  return db.prepare(
    "SELECT id, code FROM deferred_actions WHERE server = ? AND tool = ? AND args_hash = ? AND status = 'pending'"
  ).get(server, tool, argsHash) || null;
}
