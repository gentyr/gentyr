/**
 * Subprocess Call Tracker
 *
 * Records `claude -p` subprocess invocations to `.claude/state/token-usage.db`
 * `subprocess_calls` table so the token-usage-collector daemon can attribute
 * tokens consumed by daemon/hook-spawned subprocess sessions back to their
 * actual caller (e.g. 'live-feed-daemon', 'report-auto-resolve', 'migration-
 * safety') instead of marking them as 'unknown'.
 *
 * Used by:
 *   - .claude/hooks/lib/llm-client.js (callLLM, callLLMStructured)
 *   - .claude/hooks/lib/compact-session.js (claude --resume -p /compact)
 *   - .claude/hooks/lib/release-report-generator.js (claude -p text)
 *
 * The DB table is created lazily by the collector; we only ever INSERT and
 * UPDATE here. If the DB is unavailable for any reason we silently no-op so
 * the LLM call itself is never blocked by telemetry.
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'token-usage.db');

// Lazy DB handle — reused across calls in the same process.
let _db = null;

function openDb() {
  if (_db) return _db;
  try {
    if (!fs.existsSync(path.dirname(DB_PATH))) {
      fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    }
    _db = new Database(DB_PATH);
    // Ensure the table exists even if the collector hasn't run yet
    _db.exec(`
      CREATE TABLE IF NOT EXISTS subprocess_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        caller TEXT NOT NULL,
        model TEXT,
        parent_session_id TEXT,
        child_session_id TEXT,
        pid INTEGER,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        exit_code INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_sub_caller ON subprocess_calls(caller);
      CREATE INDEX IF NOT EXISTS idx_sub_child ON subprocess_calls(child_session_id);
      CREATE INDEX IF NOT EXISTS idx_sub_started ON subprocess_calls(started_at);
    `);
    // Idempotent ALTER TABLE — add token columns if missing (older DBs)
    const existingCols = new Set(_db.prepare("PRAGMA table_info(subprocess_calls)").all().map((c) => c.name));
    const TOKEN_COLS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens'];
    for (const col of TOKEN_COLS) {
      if (!existingCols.has(col)) {
        try { _db.exec(`ALTER TABLE subprocess_calls ADD COLUMN ${col} INTEGER DEFAULT 0`); } catch { /* concurrent migration race */ }
      }
    }
    return _db;
  } catch {
    _db = null;
    return null;
  }
}

/**
 * Record the start of a subprocess call. Returns a row id you must pass to
 * `finishSubprocessCall()` when the call resolves (or null on failure).
 *
 * @param {object} args
 * @param {string} args.caller - Tag identifying the calling site (REQUIRED)
 * @param {string} [args.model]
 * @param {string} [args.parentSessionId]
 * @returns {number|null} The inserted row id, or null on DB failure
 */
export function startSubprocessCall({ caller, model = null, parentSessionId = null } = {}) {
  if (!caller || typeof caller !== 'string') return null;
  const db = openDb();
  if (!db) return null;
  try {
    const result = db.prepare(
      `INSERT INTO subprocess_calls (caller, model, parent_session_id, started_at)
       VALUES (?, ?, ?, ?)`
    ).run(caller, model, parentSessionId, Date.now());
    return result.lastInsertRowid;
  } catch {
    return null;
  }
}

/**
 * Record the end of a subprocess call previously started with
 * `startSubprocessCall()`. Updates `pid`, `ended_at`, `exit_code`, and the
 * four token columns when provided.
 *
 * @param {number|null} rowId
 * @param {object} [args]
 * @param {number|null} [args.pid]
 * @param {number|null} [args.exitCode]
 * @param {number} [args.inputTokens]
 * @param {number} [args.outputTokens]
 * @param {number} [args.cacheReadTokens]
 * @param {number} [args.cacheCreationTokens]
 */
export function finishSubprocessCall(rowId, {
  pid = null,
  exitCode = null,
  inputTokens = 0,
  outputTokens = 0,
  cacheReadTokens = 0,
  cacheCreationTokens = 0,
} = {}) {
  if (!rowId) return;
  const db = openDb();
  if (!db) return;
  try {
    db.prepare(
      `UPDATE subprocess_calls
       SET pid = ?, ended_at = ?, exit_code = ?,
           input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_creation_tokens = ?
       WHERE id = ?`
    ).run(pid, Date.now(), exitCode, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, rowId);
  } catch {
    // Non-fatal
  }
}

/**
 * Close the lazy DB handle. Daemon callers may invoke this on shutdown.
 */
export function closeSubprocessCallDb() {
  if (_db) {
    try { _db.close(); } catch { /* ignore */ }
    _db = null;
  }
}

/**
 * Get the current parent session id from env, or null if not in a tagged
 * subprocess. Used by callers that want to propagate parent context to
 * nested subprocess calls.
 */
export function getCurrentParentSessionId() {
  return process.env.CLAUDE_USAGE_PARENT || null;
}
