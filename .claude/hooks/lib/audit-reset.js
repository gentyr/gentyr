/**
 * Shared audit reset logic for the universal audit gate system.
 *
 * Exposes three reset entry points — one per task DB — plus a shared
 * authorization check and an internal "kill live auditors + respawn"
 * helper. Used by:
 *   - mcp__todo-db__reset_task_audit       → resetTaskAudit
 *   - mcp__persistent-task__reset_pt_audit → resetPtAudit
 *   - mcp__plan-orchestrator__reset_plan_audit → resetPlanAudit
 *
 * Design notes
 * ------------
 *
 * - We do NOT introduce a new audit verdict value (would require a schema
 *   migration on plan_audits because of its CHECK constraint). Instead we
 *   record the reset by marking the prior pending audit row `verdict='fail'`
 *   with `failure_reason = 'Audit reset: <reason>'`, then INSERT a new
 *   audit row with `attempt_number + 1` and `verdict=NULL`. The new row is
 *   what the session-reaper's orphan-recovery and the auditor's first read
 *   will see.
 *
 * - For post-verdict resets (`completed` or post-fail `in_progress`/`active`),
 *   the prior row's verdict is preserved — that audit really did pass/fail
 *   and the evidence is still useful history. We only revert the task
 *   status to pending_audit and insert a fresh audit row.
 *
 * - Live auditor sessions for the same task are killed AFTER the DB
 *   mutations commit, so the orphan-recovery in session-reaper.js Step 1b.5
 *   has a clean pending audit row to lock onto.
 *
 * - Authorization audits (`task_type='authorization'`) are intentionally
 *   out of scope. CTO authorization is interactive and short-lived; the
 *   existing `record_cto_decision` flow handles disputes.
 *
 * @module lib/audit-reset
 */

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

// CommonJS shim so we can synchronously load better-sqlite3 (a CJS module)
// from this ESM file. ESM `import` is async and the identity-verify path is
// called inline from the resetters, so a sync require keeps that signature.
const _require = createRequire(import.meta.url);
let _Database = null;
function _loadDatabaseSync() {
  if (!_Database) _Database = _require('better-sqlite3');
  return _Database;
}

// Lazy imports — these are pure ESM but live in .claude/hooks/lib/. We do
// a dynamic import inside each entry so that test consumers can substitute
// fakes without monkey-patching the module graph at load time.
let _sessionQueue = null;
let _auditorPrompt = null;
async function _loadDeps() {
  if (!_sessionQueue) {
    _sessionQueue = await import('./session-queue.js');
  }
  if (!_auditorPrompt) {
    _auditorPrompt = await import('./auditor-prompt.js');
  }
  return { sessionQueue: _sessionQueue, auditorPrompt: _auditorPrompt };
}

/**
 * Public-facing input validation for `reason`. We require a non-trivial
 * justification so resets show up usefully in audit history.
 */
function validateReason(reason) {
  if (typeof reason !== 'string' || reason.trim().length < 10) {
    return 'reason is required and must be at least 10 characters';
  }
  return null;
}

/**
 * Identity verification — modelled on verifyUserAlignmentIdentity in
 * agent-tracker/server.ts. Reads CLAUDE_QUEUE_ID and resolves the caller's
 * agent / agent_type from session-queue.db.
 *
 * Allowed callers:
 *   - Interactive CTO (no CLAUDE_QUEUE_ID)          → ALLOW
 *   - deputy-cto / deputy-CTO global monitor        → ALLOW
 *   - persistent-monitor                            → ALLOW
 *   - plan-manager                                  → ALLOW (for plan reset only;
 *                                                          we don't enforce
 *                                                          plan-id match here —
 *                                                          server can layer that)
 *   - universal-auditor / plan-auditor /
 *     authorization-auditor                          → DENY (cannot reset itself)
 *   - everything else                               → DENY
 *
 * Failure is fail-CLOSED for spawned sessions (deny on unknown).
 *
 * @param {{ taskType: 'todo'|'persistent'|'plan', taskId: string, projectDir?: string }} _opts
 * @returns {{ allowed: boolean, reason?: string, callerAgent?: string }}
 */
export function verifyResetAuditIdentity(_opts = {}) {
  const queueId = process.env.CLAUDE_QUEUE_ID;

  // Interactive CTO session — no spawned-session env var.
  if (!queueId) {
    if (process.env.CLAUDE_SPAWNED_SESSION === 'true') {
      // Edge: spawned session without queue id (shouldn't happen normally) — fail-closed.
      return { allowed: false, reason: 'spawned session without CLAUDE_QUEUE_ID — cannot verify caller identity' };
    }
    return { allowed: true, callerAgent: 'interactive' };
  }

  // Spawned session — resolve agent type from session-queue.db.
  let agent = null;
  let agentType = null;
  try {
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const dbPath = path.join(projectDir, '.claude', 'state', 'session-queue.db');
    if (!fs.existsSync(dbPath)) {
      return { allowed: false, reason: `session-queue.db not found at ${dbPath} — cannot verify caller` };
    }
    const Database = _loadDatabaseSync();
    const db = new Database(dbPath, { readonly: true });
    db.pragma('busy_timeout = 3000');
    const row = db.prepare('SELECT agent, agent_type, metadata FROM queue_items WHERE id = ?').get(queueId);
    db.close();
    if (!row) {
      return { allowed: false, reason: `queue item ${queueId} not found — cannot verify caller` };
    }
    agent = row.agent;
    agentType = row.agent_type;
  } catch (err) {
    return { allowed: false, reason: `identity lookup failed: ${err.message}` };
  }

  const tag = String(agent || agentType || '').toLowerCase();
  const isAuditor = tag.includes('auditor');
  if (isAuditor) {
    return { allowed: false, reason: `auditor agent (${tag}) cannot reset its own audit`, callerAgent: tag };
  }
  if (tag.includes('deputy') || tag === 'deputy-cto') {
    return { allowed: true, callerAgent: tag };
  }
  if (tag.includes('persistent-monitor') || tag.includes('plan-manager')) {
    return { allowed: true, callerAgent: tag };
  }
  // Default: deny for everything else (task-runner, code-writer, etc.).
  return { allowed: false, reason: `agent type ${tag || '(unknown)'} is not authorized to reset audits — only cto/deputy-cto/persistent-monitor/plan-manager may`, callerAgent: tag };
}

/**
 * Internal: cancel live auditor sessions for a given task. Filters to the
 * audit lane + AUDITOR_AGENT_TYPES so we never accidentally kill the
 * task-runner that's auditing-adjacent.
 *
 * Returns the cancelled queue_ids.
 */
async function _cancelLiveAuditors({ taskId, taskType, projectDir }) {
  const { auditorPrompt } = await _loadDeps();
  const dbPath = path.join(projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd(), '.claude', 'state', 'session-queue.db');
  if (!fs.existsSync(dbPath)) return [];
  const Database = _loadDatabaseSync();
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 3000');
  const cancelled = [];
  try {
    const rows = db.prepare(
      "SELECT id, pid, status, agent_type FROM queue_items WHERE status IN ('queued','running','spawning','suspended') AND lane = 'audit' AND json_extract(metadata, '$.taskId') = ? AND json_extract(metadata, '$.taskType') = ?"
    ).all(taskId, taskType);
    for (const r of rows) {
      if (!auditorPrompt.AUDITOR_AGENT_TYPES.has(r.agent_type)) continue;
      if (r.status === 'queued') {
        db.prepare("UPDATE queue_items SET status='cancelled', completed_at=datetime('now'), error='audit_reset' WHERE id=?").run(r.id);
      } else if (r.pid) {
        try { process.kill(r.pid, 'SIGTERM'); } catch (_) { /* dead is fine */ }
        db.prepare("UPDATE queue_items SET status='failed', completed_at=datetime('now'), error='audit_reset' WHERE id=?").run(r.id);
      } else {
        db.prepare("UPDATE queue_items SET status='failed', completed_at=datetime('now'), error='audit_reset' WHERE id=?").run(r.id);
      }
      cancelled.push(r.id);
    }
  } finally {
    db.close();
  }
  return cancelled;
}

/**
 * Internal: respawn a fresh auditor. Returns the new queue_id or null on
 * enqueue failure (which is non-fatal — the orphan-recovery in session-
 * reaper Step 1b.5 will pick the new audit row up on the next drain cycle).
 */
async function _respawnAuditor({ taskType, taskId, taskTitle, criteria, method, projectDir }) {
  try {
    const { sessionQueue, auditorPrompt } = await _loadDeps();
    const spec = auditorPrompt.buildAuditorSessionSpec(
      { taskId, taskType, taskTitle, criteria, method },
      projectDir
    );
    const result = sessionQueue.enqueueSession({
      ...spec,
      title: `Audit (reset): ${taskTitle}`,
      source: 'audit-reset',
    });
    return result?.id || null;
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Reset a todo-db task audit. See module header for behavior.
 *
 * @param {{ db: any, taskId: string, reason: string, projectDir?: string, respawn?: boolean }} opts
 * @returns {Promise<object>} result describing the reset
 */
export async function resetTaskAudit({ db, taskId, reason, projectDir, respawn = true }) {
  const reasonErr = validateReason(reason);
  if (reasonErr) return { error: reasonErr };

  const auth = verifyResetAuditIdentity({ taskType: 'todo', taskId, projectDir });
  if (!auth.allowed) return { error: `unauthorized: ${auth.reason}` };

  const task = db.prepare('SELECT id, title, status, gate_success_criteria, gate_verification_method FROM tasks WHERE id = ?').get(taskId);
  if (!task) return { error: `task not found: ${taskId}` };

  const priorAudit = db.prepare('SELECT id, verdict, attempt_number FROM task_audits WHERE task_id = ? ORDER BY attempt_number DESC LIMIT 1').get(taskId);
  if (!priorAudit) {
    return { error: `task ${taskId} has no audit history — nothing to reset. Drive it into pending_audit first.` };
  }

  const validStatuses = ['pending_audit', 'completed', 'in_progress'];
  if (!validStatuses.includes(task.status)) {
    return { error: `cannot reset audit for task in status '${task.status}' — only pending_audit / completed / in_progress are valid` };
  }

  const ts = new Date().toISOString();
  const newAuditId = randomUUID();
  const newAttempt = (priorAudit.attempt_number || 1) + 1;

  // Run the DB mutations in one transaction.
  const mutate = db.transaction(() => {
    if (priorAudit.verdict === null) {
      // Mark prior pending audit failed with the reset note.
      db.prepare("UPDATE task_audits SET verdict = 'fail', failure_reason = ?, completed_at = ? WHERE id = ?")
        .run(`Audit reset: ${reason}`, ts, priorAudit.id);
    }
    if (task.status !== 'pending_audit') {
      db.prepare("UPDATE tasks SET status = 'pending_audit' WHERE id = ?").run(taskId);
    }
    db.prepare("INSERT INTO task_audits (id, task_id, success_criteria, verification_method, requested_at, attempt_number) VALUES (?, ?, ?, ?, ?, ?)")
      .run(newAuditId, taskId, task.gate_success_criteria || '', task.gate_verification_method || '', ts, newAttempt);
  });
  mutate();

  const cancelledQueueIds = await _cancelLiveAuditors({ taskId, taskType: 'todo', projectDir });

  let newQueueId = null;
  if (respawn) {
    const spawned = await _respawnAuditor({
      taskType: 'todo',
      taskId,
      taskTitle: task.title,
      criteria: task.gate_success_criteria || '',
      method: task.gate_verification_method || '',
      projectDir,
    });
    if (typeof spawned === 'string') newQueueId = spawned;
  }

  return {
    task_id: taskId,
    prior_audit_id: priorAudit.id,
    prior_verdict: priorAudit.verdict || 'pending',
    prior_status: task.status,
    new_status: 'pending_audit',
    cancelled_queue_ids: cancelledQueueIds,
    new_audit_id: newAuditId,
    new_attempt_number: newAttempt,
    new_queue_id: newQueueId,
    reason,
    caller_agent: auth.callerAgent,
  };
}

/**
 * Reset a persistent-task audit. Mirrors resetTaskAudit but on pt_audits +
 * persistent_tasks. Cascade-reverts a linked parent todo task if the
 * prior pt_audit was a pass that cascaded into todo.tasks completion.
 *
 * @param {{ db: any, taskId: string, reason: string, projectDir?: string, todoDbPath?: string, respawn?: boolean }} opts
 */
export async function resetPtAudit({ db, taskId, reason, projectDir, todoDbPath, respawn = true }) {
  const reasonErr = validateReason(reason);
  if (reasonErr) return { error: reasonErr };

  const auth = verifyResetAuditIdentity({ taskType: 'persistent', taskId, projectDir });
  if (!auth.allowed) return { error: `unauthorized: ${auth.reason}` };

  // NOTE: persistent_tasks stores criteria under gate_* columns (gate_success_criteria /
  // gate_verification_method). The pt_audits table uses the bare success_criteria /
  // verification_method column names. Selecting the bare names here threw
  // "no such column: success_criteria" and broke reset_pt_audit entirely.
  const task = db.prepare('SELECT id, title, status, parent_todo_task_id, gate_success_criteria, gate_verification_method FROM persistent_tasks WHERE id = ?').get(taskId);
  if (!task) return { error: `persistent task not found: ${taskId}` };

  const priorAudit = db.prepare('SELECT id, verdict, attempt_number FROM pt_audits WHERE persistent_task_id = ? ORDER BY attempt_number DESC LIMIT 1').get(taskId);
  if (!priorAudit) {
    return { error: `persistent task ${taskId} has no audit history — nothing to reset` };
  }

  const validStatuses = ['pending_audit', 'completed', 'active'];
  if (!validStatuses.includes(task.status)) {
    return { error: `cannot reset audit for persistent task in status '${task.status}' — only pending_audit / completed / active are valid` };
  }

  const ts = new Date().toISOString();
  const newAuditId = randomUUID();
  const newAttempt = (priorAudit.attempt_number || 1) + 1;
  const wasCompleted = task.status === 'completed';

  const mutate = db.transaction(() => {
    if (priorAudit.verdict === null) {
      db.prepare("UPDATE pt_audits SET verdict = 'fail', failure_reason = ?, completed_at = ? WHERE id = ?")
        .run(`Audit reset: ${reason}`, ts, priorAudit.id);
    }
    if (task.status !== 'pending_audit') {
      db.prepare("UPDATE persistent_tasks SET status = 'pending_audit' WHERE id = ?").run(taskId);
    }
    db.prepare("INSERT INTO pt_audits (id, persistent_task_id, success_criteria, verification_method, requested_at, attempt_number) VALUES (?, ?, ?, ?, ?, ?)")
      .run(newAuditId, taskId, task.gate_success_criteria || '', task.gate_verification_method || '', ts, newAttempt);
  });
  mutate();

  // Cascade: if PT was completed (post audit-pass cascaded a parent todo task
  // to completed), revert the parent back to pending_audit so it tracks PT state.
  let cascadedParentId = null;
  if (wasCompleted && task.parent_todo_task_id && todoDbPath && fs.existsSync(todoDbPath)) {
    try {
      const Database = _loadDatabaseSync();
      const todoDb = new Database(todoDbPath);
      todoDb.pragma('journal_mode = WAL');
      todoDb.pragma('busy_timeout = 5000');
      const parentRow = todoDb.prepare('SELECT id, status FROM tasks WHERE id = ?').get(task.parent_todo_task_id);
      if (parentRow && parentRow.status === 'completed') {
        todoDb.prepare("UPDATE tasks SET status = 'pending_audit', completed_at = NULL WHERE id = ?").run(task.parent_todo_task_id);
        cascadedParentId = task.parent_todo_task_id;
      }
      todoDb.close();
    } catch (_) { /* non-fatal cascade */ }
  }

  const cancelledQueueIds = await _cancelLiveAuditors({ taskId, taskType: 'persistent', projectDir });

  let newQueueId = null;
  if (respawn) {
    const spawned = await _respawnAuditor({
      taskType: 'persistent',
      taskId,
      taskTitle: task.title,
      criteria: task.gate_success_criteria || '',
      method: task.gate_verification_method || '',
      projectDir,
    });
    if (typeof spawned === 'string') newQueueId = spawned;
  }

  return {
    task_id: taskId,
    prior_audit_id: priorAudit.id,
    prior_verdict: priorAudit.verdict || 'pending',
    prior_status: task.status,
    new_status: 'pending_audit',
    cascaded_parent_todo_id: cascadedParentId,
    cancelled_queue_ids: cancelledQueueIds,
    new_audit_id: newAuditId,
    new_attempt_number: newAttempt,
    new_queue_id: newQueueId,
    reason,
    caller_agent: auth.callerAgent,
  };
}

/**
 * Reset a plan_orchestrator plan-task audit. Mirrors resetTaskAudit but on
 * plan_audits + plan_tasks. Also writes a state_change row so the plan
 * timeline reflects the reset.
 *
 * @param {{ db: any, planTaskId: string, reason: string, projectDir?: string, respawn?: boolean }} opts
 */
export async function resetPlanAudit({ db, planTaskId, reason, projectDir, respawn = true }) {
  const reasonErr = validateReason(reason);
  if (reasonErr) return { error: reasonErr };

  const auth = verifyResetAuditIdentity({ taskType: 'plan', taskId: planTaskId, projectDir });
  if (!auth.allowed) return { error: `unauthorized: ${auth.reason}` };

  const task = db.prepare('SELECT id, plan_id, title, status, verification_strategy FROM plan_tasks WHERE id = ?').get(planTaskId);
  if (!task) return { error: `plan task not found: ${planTaskId}` };

  const priorAudit = db.prepare('SELECT id, verdict, attempt_number FROM plan_audits WHERE task_id = ? ORDER BY attempt_number DESC LIMIT 1').get(planTaskId);
  if (!priorAudit) {
    return { error: `plan task ${planTaskId} has no audit history — nothing to reset` };
  }

  const validStatuses = ['pending_audit', 'completed', 'in_progress', 'ready'];
  if (!validStatuses.includes(task.status)) {
    return { error: `cannot reset audit for plan task in status '${task.status}' — only pending_audit / completed / in_progress / ready are valid` };
  }

  const ts = new Date().toISOString();
  const newAuditId = randomUUID();
  const newAttempt = (priorAudit.attempt_number || 1) + 1;
  const priorStatus = task.status;

  const mutate = db.transaction(() => {
    if (priorAudit.verdict === null) {
      db.prepare("UPDATE plan_audits SET verdict = 'fail', failure_reason = ?, completed_at = ? WHERE id = ?")
        .run(`Audit reset: ${reason}`, ts, priorAudit.id);
    }
    if (task.status !== 'pending_audit') {
      db.prepare("UPDATE plan_tasks SET status = 'pending_audit' WHERE id = ?").run(planTaskId);
      // state_change row so plan_timeline reflects the reset
      db.prepare("INSERT INTO state_changes (id, entity_type, entity_id, field_name, old_value, new_value, changed_at, changed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(randomUUID(), 'task', planTaskId, 'status', priorStatus, 'pending_audit', ts, 'audit_reset');
    }
    db.prepare("INSERT INTO plan_audits (id, task_id, plan_id, verification_strategy, requested_at, attempt_number) VALUES (?, ?, ?, ?, ?, ?)")
      .run(newAuditId, planTaskId, task.plan_id, task.verification_strategy || '', ts, newAttempt);
  });
  mutate();

  const cancelledQueueIds = await _cancelLiveAuditors({ taskId: planTaskId, taskType: 'plan', projectDir });

  let newQueueId = null;
  if (respawn) {
    const spawned = await _respawnAuditor({
      taskType: 'plan',
      taskId: planTaskId,
      taskTitle: task.title,
      criteria: task.verification_strategy || '',
      method: '',
      projectDir,
    });
    if (typeof spawned === 'string') newQueueId = spawned;
  }

  return {
    plan_task_id: planTaskId,
    plan_id: task.plan_id,
    prior_audit_id: priorAudit.id,
    prior_verdict: priorAudit.verdict || 'pending',
    prior_status: priorStatus,
    new_status: 'pending_audit',
    cancelled_queue_ids: cancelledQueueIds,
    new_audit_id: newAuditId,
    new_attempt_number: newAttempt,
    new_queue_id: newQueueId,
    reason,
    caller_agent: auth.callerAgent,
  };
}
