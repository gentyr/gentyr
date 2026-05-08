/**
 * Deputy Resolution Executor
 *
 * Executes deputy-CTO bypass resolutions and deferred action approvals
 * AFTER an authorization auditor has verified the deputy's decision.
 *
 * This module is consumed by the deferred-action-audit-executor.js PostToolUse hook
 * (Phase 1 of the Unified CTO Authorization System). When the auditor passes a
 * cto_decision with decision_type === 'deputy_bypass_resolution' or
 * 'deputy_deferred_approval', the executor imports this module and calls the
 * appropriate function.
 *
 * Two exports:
 * - executeDeputyBypassResolution(decisionId, projectDir)
 *   Resolves a bypass request: updates status, resumes tasks, propagates to plans
 *
 * - executeDeputyDeferredApproval(decisionId, projectDir)
 *   Approves and executes a deferred protected action via MCP daemon
 *
 * @module lib/deputy-resolution-executor
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// Lazy SQLite
let Database = null;
try {
  Database = (await import('better-sqlite3')).default;
} catch (_) {
  // SQLite unavailable
}

/**
 * Open bypass-requests.db in read-write mode.
 * @param {string} projectDir
 * @returns {object|null}
 */
function openBypassDb(projectDir) {
  if (!Database) return null;
  const dbPath = path.join(projectDir, '.claude', 'state', 'bypass-requests.db');
  if (!fs.existsSync(dbPath)) return null;
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  return db;
}

/**
 * Open a database in readonly mode.
 * @param {string} dbPath
 * @returns {object|null}
 */
function openReadonly(dbPath) {
  if (!Database) return null;
  if (!fs.existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true });
  db.pragma('busy_timeout = 3000');
  return db;
}

/**
 * Execute a deputy bypass resolution after auditor verification.
 *
 * Reads the cto_decisions record, extracts the deputy's decision (approved/rejected)
 * and the bypass request ID, then performs the same resolution logic that
 * deputy_resolve_bypass_request originally did inline.
 *
 * @param {string} decisionId - The cto_decisions.id
 * @param {string} projectDir - Absolute path to the project directory
 * @returns {Promise<{ success: boolean, message: string, error?: string }>}
 */
export async function executeDeputyBypassResolution(decisionId, projectDir) {
  let db = null;
  try {
    db = openBypassDb(projectDir);
    if (!db) {
      return { success: false, error: 'Cannot open bypass-requests.db' };
    }

    // Read the cto_decision to get context
    const decision = db.prepare(
      "SELECT id, decision_id, verbatim_text, decision_context, status FROM cto_decisions WHERE id = ?"
    ).get(decisionId);

    if (!decision) {
      return { success: false, error: `CTO decision not found: ${decisionId}` };
    }

    let context;
    try {
      context = JSON.parse(decision.decision_context || '{}');
    } catch {
      return { success: false, error: 'Failed to parse decision_context JSON' };
    }

    const bypassRequestId = context.bypass_request_id || decision.decision_id;
    const deputyDecision = context.deputy_decision; // 'approved' or 'rejected'

    if (!bypassRequestId) {
      return { success: false, error: 'No bypass_request_id in decision context' };
    }
    if (!deputyDecision || (deputyDecision !== 'approved' && deputyDecision !== 'rejected')) {
      return { success: false, error: `Invalid deputy_decision: ${deputyDecision}` };
    }

    // Read the bypass request
    const request = db.prepare(
      'SELECT id, task_type, task_id, task_title, status FROM bypass_requests WHERE id = ?'
    ).get(bypassRequestId);

    if (!request) {
      return { success: false, error: `Bypass request not found: ${bypassRequestId}` };
    }
    if (request.status !== 'pending') {
      return { success: false, error: `Bypass request is already ${request.status}. Expected pending.` };
    }

    // Now perform the actual resolution
    const resolvedContext = `[Deputy-CTO Monitor Decision — Auditor Verified] ${decision.verbatim_text}`;
    db.prepare(
      "UPDATE bypass_requests SET status = ?, resolution_context = ?, resolved_at = datetime('now'), resolved_by = 'deputy-cto-monitor' WHERE id = ?"
    ).run(deputyDecision, resolvedContext, request.id);

    // Mark the cto_decision as consumed
    db.prepare(
      "UPDATE cto_decisions SET status = 'consumed', consumed_at = datetime('now') WHERE id = ?"
    ).run(decisionId);

    if (deputyDecision === 'approved') {
      if (request.task_type === 'persistent') {
        const ptDbPath = path.join(projectDir, '.claude', 'state', 'persistent-tasks.db');
        if (fs.existsSync(ptDbPath)) {
          let ptDb = null;
          try {
            ptDb = new Database(ptDbPath);
            ptDb.pragma('busy_timeout = 3000');
            const result = ptDb.prepare(
              "UPDATE persistent_tasks SET status = 'active' WHERE id = ? AND status = 'paused'"
            ).run(request.task_id);

            if (result.changes > 0) {
              ptDb.prepare(
                "INSERT INTO events (id, persistent_task_id, event_type, details, created_at) VALUES (?, ?, 'resumed', ?, datetime('now'))"
              ).run(
                crypto.randomUUID(),
                request.task_id,
                JSON.stringify({
                  reason: 'deputy_bypass_approved_audited',
                  bypass_request_id: request.id,
                  decision_id: decisionId,
                }),
              );
            }
          } finally {
            try { ptDb?.close(); } catch { /* best-effort */ }
          }

          // Enqueue a monitor revival via session-queue
          try {
            const queueModulePath = path.join(projectDir, '.claude', 'hooks', 'lib', 'session-queue.js');
            const revivalPromptPath = path.join(projectDir, '.claude', 'hooks', 'lib', 'persistent-monitor-revival-prompt.js');
            if (fs.existsSync(queueModulePath) && fs.existsSync(revivalPromptPath)) {
              const ptDbR = openReadonly(ptDbPath);
              const task = ptDbR?.prepare('SELECT id, title, metadata, monitor_session_id FROM persistent_tasks WHERE id = ?').get(request.task_id);
              ptDbR?.close();

              if (task) {
                const { buildPersistentMonitorRevivalPrompt } = await import(revivalPromptPath);
                const revival = await buildPersistentMonitorRevivalPrompt(task, 'deputy_bypass_approved_audited', projectDir);
                const queueModule = await import(queueModulePath);
                queueModule.enqueueSession({
                  title: `[Persistent] Deputy bypass approved (audited): ${task.title}`,
                  agentType: 'persistent-task-monitor',
                  hookType: 'persistent-task-monitor',
                  tagContext: 'persistent-monitor',
                  source: 'deputy-bypass-resolve-audited',
                  prompt: revival.prompt,
                  priority: 'critical',
                  lane: 'persistent',
                  spawnType: task.monitor_session_id ? 'resume' : 'fresh',
                  resumeSessionId: task.monitor_session_id || undefined,
                  extraEnv: revival.extraEnv,
                  metadata: { ...revival.metadata, persistentTaskId: request.task_id },
                  agent: revival.agent,
                  ttlMs: 0,
                });
              }
            }
          } catch (err) {
            process.stderr.write(`[deputy-resolution-executor] Failed to enqueue revival: ${err instanceof Error ? err.message : String(err)}\n`);
          }
        }

        // Back-propagate resume to plan layer
        try {
          const bypassRow = db.prepare('SELECT propagation_context FROM bypass_requests WHERE id = ?').get(bypassRequestId);
          if (bypassRow?.propagation_context) {
            const ctx = JSON.parse(bypassRow.propagation_context);
            if (ctx.plan_task_id) {
              const pausePropagationPath = path.join(projectDir, '.claude', 'hooks', 'lib', 'pause-propagation.js');
              const { propagateResumeToPlan } = await import(pausePropagationPath);
              propagateResumeToPlan(request.task_id);
            }
          }
        } catch { /* back-propagation is non-fatal */ }

        return {
          success: true,
          message: `Deputy bypass resolution executed (audited). Persistent task "${request.task_title}" set to active, monitor revival enqueued.`,
        };
      } else {
        // Todo task — bypass guard clears and normal spawning resumes
        return {
          success: true,
          message: `Deputy bypass resolution executed (audited). Todo task "${request.task_title}" will be picked up by the next spawn cycle.`,
        };
      }
    }

    // Rejection path
    return {
      success: true,
      message: `Deputy bypass rejection executed (audited). Task "${request.task_title}" remains ${request.task_type === 'persistent' ? 'paused' : 'pending'}.`,
    };
  } catch (err) {
    return { success: false, error: `Failed to execute deputy bypass resolution: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    try { db?.close(); } catch { /* best-effort */ }
  }
}

/**
 * Execute a deputy deferred action approval after auditor verification.
 *
 * Reads the cto_decisions record, extracts the deferred action ID, then
 * performs the same approval+execution logic that deputy_approve_deferred_action
 * originally did inline.
 *
 * @param {string} decisionId - The cto_decisions.id
 * @param {string} projectDir - Absolute path to the project directory
 * @returns {Promise<{ success: boolean, message: string, result?: object, error?: string }>}
 */
export async function executeDeputyDeferredApproval(decisionId, projectDir) {
  let db = null;
  try {
    db = openBypassDb(projectDir);
    if (!db) {
      return { success: false, error: 'Cannot open bypass-requests.db' };
    }

    // Read the cto_decision to get context
    const decision = db.prepare(
      "SELECT id, decision_id, verbatim_text, decision_context, status FROM cto_decisions WHERE id = ?"
    ).get(decisionId);

    if (!decision) {
      return { success: false, error: `CTO decision not found: ${decisionId}` };
    }

    let context;
    try {
      context = JSON.parse(decision.decision_context || '{}');
    } catch {
      return { success: false, error: 'Failed to parse decision_context JSON' };
    }

    const actionId = context.deferred_action_id || decision.decision_id;
    if (!actionId) {
      return { success: false, error: 'No deferred_action_id in decision context' };
    }

    // Read the deferred action
    const action = db.prepare(
      'SELECT id, server, tool, args, args_hash, status FROM deferred_actions WHERE id = ?'
    ).get(actionId);

    if (!action) {
      return { success: false, error: `Deferred action not found: ${actionId}` };
    }
    if (action.status !== 'pending') {
      return { success: false, error: `Deferred action is already ${action.status}. Expected pending.` };
    }

    // Mark the cto_decision as consumed
    db.prepare(
      "UPDATE cto_decisions SET status = 'consumed', consumed_at = datetime('now') WHERE id = ?"
    ).run(decisionId);

    // Mark as approved
    const approvedTransition = db.prepare(
      "UPDATE deferred_actions SET status = 'approved', approved_at = datetime('now') WHERE id = ? AND status = 'pending'"
    ).run(action.id);
    if (approvedTransition.changes === 0) {
      return { success: false, error: 'Failed to approve action — it may have been approved by another process.' };
    }

    // Mark as executing (atomic transition prevents double-execution)
    const executingTransition = db.prepare(
      "UPDATE deferred_actions SET status = 'executing' WHERE id = ? AND status = 'approved'"
    ).run(action.id);
    if (executingTransition.changes === 0) {
      return { success: false, error: 'Failed to transition action to executing — it may have been picked up by another process.' };
    }

    // Parse args
    let parsedArgs;
    try {
      parsedArgs = typeof action.args === 'string' ? JSON.parse(action.args) : action.args;
    } catch {
      db.prepare(
        "UPDATE deferred_actions SET status = 'failed', execution_error = 'Failed to parse action arguments', executed_at = datetime('now') WHERE id = ?"
      ).run(action.id);
      return { success: false, error: 'Failed to parse deferred action arguments.' };
    }

    // Execute via MCP daemon
    try {
      const executorPath = path.join(projectDir, '.claude', 'hooks', 'lib', 'deferred-action-executor.js');
      const { executeMcpTool, isTier1Server } = await import(executorPath);

      if (!isTier1Server(action.server)) {
        db.prepare(
          "UPDATE deferred_actions SET status = 'failed', execution_error = ?, executed_at = datetime('now') WHERE id = ?"
        ).run(`Server "${action.server}" is not a Tier 1 server.`, action.id);
        return { success: false, error: `Server "${action.server}" is not a Tier 1 server. Deferred execution only supports Tier 1 (shared daemon) servers.` };
      }

      const result = await executeMcpTool(action.server, action.tool, parsedArgs);

      if (result.success) {
        db.prepare(
          "UPDATE deferred_actions SET status = 'completed', execution_result = ?, executed_at = datetime('now') WHERE id = ?"
        ).run(JSON.stringify({
          ...result.result,
          approved_by: 'deputy-cto-monitor',
          audited: true,
          decision_id: decisionId,
          reasoning: decision.verbatim_text,
        }), action.id);
        return {
          success: true,
          result: result.result,
          message: `Deputy deferred action executed (audited): ${action.server}:${action.tool}`,
        };
      } else {
        db.prepare(
          "UPDATE deferred_actions SET status = 'failed', execution_error = ?, executed_at = datetime('now') WHERE id = ?"
        ).run(result.error, action.id);
        return {
          success: false,
          error: result.error,
          message: `Deputy deferred action approved (audited) but execution failed: ${result.error}`,
        };
      }
    } catch (err) {
      db.prepare(
        "UPDATE deferred_actions SET status = 'failed', execution_error = ?, executed_at = datetime('now') WHERE id = ?"
      ).run((err instanceof Error ? err.message : String(err)), action.id);
      return { success: false, error: `Failed to execute deferred action: ${err instanceof Error ? err.message : String(err)}` };
    }
  } catch (err) {
    return { success: false, error: `Failed to execute deputy deferred approval: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    try { db?.close(); } catch { /* best-effort */ }
  }
}
