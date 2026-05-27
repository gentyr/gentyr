/**
 * Audit Escalation — wedged-audit detection and deputy-cto reporting.
 *
 * PR 4 (Fix 3): Closes the 2026-05-27 failure mode where the T10 (Billing)
 * audit sat in pending_audit for 2+ hours despite Step 1b.5 supposedly
 * re-enqueuing stale auditors every 10 minutes. Either the reviver did not
 * fire, or it kept respawning and each respawn hit the same root cause (the
 * dirty-tree bug closed by PR 3). Result: the agent filed a CTO bypass
 * request asking the CTO to manually call reset_pt_audit.
 *
 * This module is the missing escalation ladder: after N respawns OR a
 * wall-time ceiling, we STOP respawning and instead reset the audit (so
 * the task is no longer wedged) and emit a deputy_reports row (so the
 * deputy-cto sees the wedged audit in its inbox and can triage it without
 * involving the CTO).
 *
 * Three exports:
 *   - shouldEscalateAudit({ taskType, taskId, projectDir })
 *   - resetAuditAndReport({ taskType, taskId, kind, payload, projectDir })
 *   - getAuditAttemptStats({ taskType, taskId, projectDir })
 *
 * @module lib/audit-escalation
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const requireForLib = createRequire(import.meta.url);

let Database;
try {
  Database = requireForLib('better-sqlite3');
} catch {
  // SQLite unavailable — module still loads; functions become no-ops.
}

// Escalation thresholds. Conservative defaults — 3 failed audits OR 45 min
// wall time is enough evidence that respawning won't help.
export const MAX_AUDIT_ATTEMPTS = 3;
export const MAX_AUDIT_WALL_MINUTES = 45;

/**
 * Resolve the auditor-attempts state for a task. Returns the highest
 * `attempt_number` and the earliest `requested_at` across all audit rows
 * for the task (across whichever DB owns audits for that taskType).
 *
 * @param {{ taskType: 'todo'|'persistent'|'plan', taskId: string, projectDir: string }} opts
 * @returns {{ attempts: number, firstAttemptAt: string|null, lastAttemptAt: string|null }|null}
 */
export function getAuditAttemptStats({ taskType, taskId, projectDir }) {
  if (!Database) return null;
  const dbPath = auditDbPath(taskType, projectDir);
  const table = auditTableName(taskType);
  if (!dbPath || !fs.existsSync(dbPath) || !table) return null;
  let db;
  try {
    db = new Database(dbPath, { readonly: true });
    db.pragma('busy_timeout = 1000');
    // Defensive: some audit tables use different ID column names. todo_db
    // uses task_id; persistent uses task_id (mirrors the same); plan uses
    // plan_task_id. All have attempt_number and requested_at.
    const idColumn = taskType === 'plan' ? 'plan_task_id' : 'task_id';
    const row = db.prepare(`
      SELECT
        MAX(attempt_number) AS attempts,
        MIN(requested_at)   AS first_attempt_at,
        MAX(requested_at)   AS last_attempt_at
      FROM ${table}
      WHERE ${idColumn} = ?
    `).get(taskId);
    if (!row || row.attempts == null) return { attempts: 0, firstAttemptAt: null, lastAttemptAt: null };
    return {
      attempts: row.attempts,
      firstAttemptAt: row.first_attempt_at,
      lastAttemptAt: row.last_attempt_at,
    };
  } catch {
    return null;
  } finally {
    try { db && db.close(); } catch { /* best-effort */ }
  }
}

/**
 * Decide whether the next revival should escalate (reset + report) instead
 * of respawning the auditor. Returns `{ escalate, reason, attempts, ageMin }`.
 * Fail-open: when stats cannot be read, returns `{ escalate: false }` so the
 * legacy respawn path keeps working.
 *
 * @param {{ taskType: string, taskId: string, projectDir: string }} opts
 * @returns {{ escalate: boolean, reason: string|null, attempts: number, ageMin: number }}
 */
export function shouldEscalateAudit({ taskType, taskId, projectDir }) {
  const stats = getAuditAttemptStats({ taskType, taskId, projectDir });
  if (!stats) return { escalate: false, reason: null, attempts: 0, ageMin: 0 };
  const attempts = stats.attempts || 0;
  const ageMin = stats.firstAttemptAt
    ? Math.max(0, Math.floor((Date.now() - new Date(stats.firstAttemptAt).getTime()) / 60000))
    : 0;
  if (attempts >= MAX_AUDIT_ATTEMPTS) {
    return { escalate: true, reason: `attempts=${attempts} >= ${MAX_AUDIT_ATTEMPTS}`, attempts, ageMin };
  }
  if (ageMin >= MAX_AUDIT_WALL_MINUTES) {
    return { escalate: true, reason: `age=${ageMin}min >= ${MAX_AUDIT_WALL_MINUTES}min`, attempts, ageMin };
  }
  return { escalate: false, reason: null, attempts, ageMin };
}

/**
 * Reset a wedged audit and file a deputy_reports row.
 *
 * Reset semantics by task type:
 *   - todo       → tasks.status = 'in_progress' (auditor re-runs on next completion)
 *   - persistent → persistent_tasks.status = 'in_progress' (same)
 *   - plan       → plan_tasks.status = 'in_progress', plan_audits row marked 'failed'
 *
 * Plus: mark the most-recent audit row failed with the escalation reason in
 * `failure_reason` (so subsequent reset_*_audit calls can show history).
 *
 * Then INSERT into deputy_reports with kind='wedged_audit' and the full
 * payload for triage. Idempotent: if a 'wedged_audit' report for this task
 * already exists in 'open' status, no new row is inserted.
 *
 * @param {object} opts
 * @param {'todo'|'persistent'|'plan'} opts.taskType
 * @param {string} opts.taskId
 * @param {object} opts.payload  - Full report payload (audit_history, attempts, etc.)
 * @param {string} opts.projectDir
 * @returns {{ reset: boolean, reportId: string|null, reason: string|null }}
 */
export function resetAuditAndReport({ taskType, taskId, payload, projectDir }) {
  if (!Database) return { reset: false, reportId: null, reason: 'sqlite_unavailable' };

  // 1. Reset the task row in its owning DB so it leaves pending_audit.
  const reset = resetTaskStatus(taskType, taskId, projectDir);
  if (!reset.ok) {
    return { reset: false, reportId: null, reason: reset.reason };
  }

  // 2. Mark most-recent audit row as failed (best-effort, non-fatal).
  markLatestAuditFailed(taskType, taskId, projectDir);

  // 3. INSERT or skip if open report already exists.
  const reportId = upsertDeputyReport({
    kind: 'wedged_audit',
    taskType,
    taskId,
    payload,
    projectDir,
  });

  return { reset: true, reportId, reason: null };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function auditDbPath(taskType, projectDir) {
  if (taskType === 'todo') return path.join(projectDir, '.claude', 'todo.db');
  if (taskType === 'persistent') return path.join(projectDir, '.claude', 'state', 'persistent-tasks.db');
  if (taskType === 'plan') return path.join(projectDir, '.claude', 'state', 'plans.db');
  return null;
}

function auditTableName(taskType) {
  if (taskType === 'todo') return 'task_audits';
  if (taskType === 'persistent') return 'pt_audits';
  if (taskType === 'plan') return 'plan_audits';
  return null;
}

function taskTableName(taskType) {
  if (taskType === 'todo') return 'tasks';
  if (taskType === 'persistent') return 'persistent_tasks';
  if (taskType === 'plan') return 'plan_tasks';
  return null;
}

function resetTaskStatus(taskType, taskId, projectDir) {
  const dbPath = auditDbPath(taskType, projectDir);
  const table = taskTableName(taskType);
  if (!dbPath || !fs.existsSync(dbPath) || !table) {
    return { ok: false, reason: 'db_missing' };
  }
  let db;
  try {
    db = new Database(dbPath);
    db.pragma('busy_timeout = 3000');
    const result = db.prepare(`
      UPDATE ${table}
         SET status = 'in_progress'
       WHERE id = ? AND status = 'pending_audit'
    `).run(taskId);
    return { ok: true, changes: result.changes };
  } catch (err) {
    return { ok: false, reason: err.message };
  } finally {
    try { db && db.close(); } catch { /* best-effort */ }
  }
}

function markLatestAuditFailed(taskType, taskId, projectDir) {
  const dbPath = auditDbPath(taskType, projectDir);
  const table = auditTableName(taskType);
  if (!dbPath || !fs.existsSync(dbPath) || !table) return;
  let db;
  try {
    db = new Database(dbPath);
    db.pragma('busy_timeout = 3000');
    const idColumn = taskType === 'plan' ? 'plan_task_id' : 'task_id';
    // Find the most-recent audit row with no verdict yet and mark it failed.
    const row = db.prepare(`
      SELECT id FROM ${table}
       WHERE ${idColumn} = ? AND verdict IS NULL
       ORDER BY requested_at DESC LIMIT 1
    `).get(taskId);
    if (!row) return;
    // Try with failure_reason column; fall back to verdict update only.
    try {
      db.prepare(`
        UPDATE ${table}
           SET verdict = 'fail',
               failure_reason = 'Audit escalated to deputy-cto: wedged after repeated revivals'
         WHERE id = ?
      `).run(row.id);
    } catch {
      db.prepare(`UPDATE ${table} SET verdict = 'fail' WHERE id = ?`).run(row.id);
    }
  } catch { /* best-effort */ } finally {
    try { db && db.close(); } catch { /* best-effort */ }
  }
}

function upsertDeputyReport({ kind, taskType, taskId, payload, projectDir }) {
  // Co-located with bypass_requests / blocking_queue / cto_decisions —
  // matches the agent-tracker MCP server's BYPASS_DB_PATH so the MCP tools
  // see the same rows the reaper writes.
  const dbPath = path.join(projectDir, '.claude', 'state', 'bypass-requests.db');
  if (!fs.existsSync(path.dirname(dbPath))) {
    try { fs.mkdirSync(path.dirname(dbPath), { recursive: true }); } catch { /* best-effort */ }
  }
  let db;
  try {
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 3000');
    db.exec(`
      CREATE TABLE IF NOT EXISTS deputy_reports (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        task_type TEXT,
        task_id TEXT,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        acknowledged_at TEXT,
        resolved_at TEXT,
        resolution TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_deputy_reports_open ON deputy_reports(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_deputy_reports_task ON deputy_reports(task_type, task_id, kind);
    `);

    // Idempotency: skip if an OPEN report already exists for this kind+task.
    const existing = db.prepare(`
      SELECT id FROM deputy_reports
       WHERE kind = ? AND task_type = ? AND task_id = ? AND status = 'open'
       LIMIT 1
    `).get(kind, taskType, taskId);
    if (existing) return existing.id;

    const id = `dr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    db.prepare(`
      INSERT INTO deputy_reports (id, kind, task_type, task_id, payload)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, kind, taskType, taskId, JSON.stringify(payload || {}));
    return id;
  } catch {
    return null;
  } finally {
    try { db && db.close(); } catch { /* best-effort */ }
  }
}
