/**
 * Session Audit Log — structured JSON-lines audit trail for session lifecycle events.
 *
 * Single log file at .claude/state/session-audit.log. JSON-lines format.
 *
 * Event types:
 *   session_enqueued, session_spawned, session_completed, session_failed,
 *   session_cancelled, session_ttl_expired, session_reaped_dead,
 *   session_reaped_complete, session_hard_killed, session_revival_triggered,
 *   session_suspended, session_preempted
 *
 * CTO Preemption Events:
 *   session_suspended — emitted when a running session is preempted by a CTO task.
 *     Fields: queue_id, agent_id, pid, title, priority, elapsed, cto_queue_id, session_id
 *   session_preempted — emitted for the CTO task that triggered a preemption.
 *     Fields: cto_queue_id, preempted_queue_id, preempted_agent_id, preempted_title
 *
 * @module lib/session-audit
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const AUDIT_LOG_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'session-audit.log');

// Cleanup thresholds
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_INTERVAL = 100; // Every N writes

let _writesSinceCleanup = 0;

/**
 * Append a single audit event to the log.
 *
 * @param {string} event - Event type (e.g., 'session_spawned')
 * @param {object} [fields={}] - Additional event fields
 */
export function auditEvent(event, fields = {}) {
  try {
    const dir = path.dirname(AUDIT_LOG_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + '\n';
    fs.appendFileSync(AUDIT_LOG_PATH, line);

    _writesSinceCleanup++;
    if (_writesSinceCleanup >= CLEANUP_INTERVAL) {
      _writesSinceCleanup = 0;
      _maybeCleanup();
    }
  } catch (err) {
    // Non-fatal — audit must never crash callers. Log to stderr for diagnostics.
    try { process.stderr.write(`[session-audit] auditEvent error: ${err.message}\n`); } catch (err) {
      console.error('[session-audit] Warning:', err.message);
    }
  }
}

/**
 * Delete audit log lines older than 24 hours via atomic tmp+rename rewrite.
 * Also halves the file if it exceeds 5MB.
 */
export function cleanupAuditLog() {
  try {
    if (!fs.existsSync(AUDIT_LOG_PATH)) return;

    const stat = fs.statSync(AUDIT_LOG_PATH);
    const lines = fs.readFileSync(AUDIT_LOG_PATH, 'utf8').split('\n').filter(l => l.trim());

    if (lines.length === 0) return;

    const cutoff = Date.now() - MAX_AGE_MS;
    let kept = lines.filter(line => {
      try {
        const parsed = JSON.parse(line);
        return new Date(parsed.ts).getTime() > cutoff;
      } catch (err) {
        console.error('[session-audit] Warning:', err.message);
        return false; // Discard unparseable lines
      }
    });

    // If still over 5MB, keep only the newer half
    if (stat.size > MAX_FILE_SIZE && kept.length > 1) {
      kept = kept.slice(Math.floor(kept.length / 2));
    }

    // Atomic write via tmp+rename
    const tmpPath = AUDIT_LOG_PATH + '.tmp';
    fs.writeFileSync(tmpPath, kept.join('\n') + (kept.length > 0 ? '\n' : ''));
    fs.renameSync(tmpPath, AUDIT_LOG_PATH);
  } catch (err) {
    // Non-fatal — log to stderr for diagnostics.
    try { process.stderr.write(`[session-audit] cleanupAuditLog error: ${err.message}\n`); } catch (err) {
      console.error('[session-audit] Warning:', err.message);
    }
  }
}

/**
 * Internal: check file size and trigger cleanup if needed.
 */
function _maybeCleanup() {
  try {
    if (!fs.existsSync(AUDIT_LOG_PATH)) return;
    const stat = fs.statSync(AUDIT_LOG_PATH);
    if (stat.size > MAX_FILE_SIZE) {
      cleanupAuditLog();
    }
  } catch (err) {
    console.error('[session-audit] Warning:', err.message);
    // Non-fatal
  }
}
