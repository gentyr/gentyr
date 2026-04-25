/**
 * pause-propagation.js — Hierarchical pause/resume propagation
 *
 * When a persistent task is paused, propagates the pause up to the plan layer:
 * - Updates the linked plan task status to 'paused'
 * - Assesses plan impact (dependencies, gates, parallel work)
 * - Auto-pauses the plan if fully blocked
 * - Creates a blocking_queue entry for CTO visibility
 *
 * When a persistent task is resumed, propagates the resume back up:
 * - Resumes the plan task
 * - Resolves blocking_queue entries
 * - Resumes the plan if no other tasks are paused
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const PERSISTENT_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
const PLANS_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'plans.db');
const BYPASS_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'bypass-requests.db');

let Database = null;
try {
  Database = (await import('better-sqlite3')).default;
} catch (_) {
  // SQLite unavailable — all functions return safe defaults
}

/**
 * Ensure the blocking_queue table exists in bypass-requests.db.
 * Called before any read/write on the bypass DB to handle fresh installs.
 *
 * @param {import('better-sqlite3').Database} db - An open bypass-requests DB connection
 */
function ensureBlockingQueueTable(db) {
  // Schema must match the canonical definition in agent-tracker/server.ts getBypassDb()
  db.exec(`
    CREATE TABLE IF NOT EXISTS blocking_queue (
      id TEXT PRIMARY KEY,
      bypass_request_id TEXT,
      source_task_type TEXT NOT NULL,
      source_task_id TEXT NOT NULL,
      persistent_task_id TEXT,
      plan_task_id TEXT,
      plan_id TEXT,
      plan_title TEXT,
      blocking_level TEXT NOT NULL DEFAULT 'task',
      impact_assessment TEXT,
      summary TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      resolved_at TEXT,
      resolution_context TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (blocking_level IN ('task', 'persistent_task', 'plan')),
      CHECK (status IN ('active', 'resolved', 'superseded'))
    );
    CREATE INDEX IF NOT EXISTS idx_blocking_queue_status ON blocking_queue(status);
  `);
}

/**
 * Propagate a persistent task pause up to the plan layer.
 *
 * Reads the persistent task's metadata for plan linkage. If linked, updates
 * the plan task to 'paused', assesses downstream impact, optionally auto-pauses
 * the plan itself when fully blocked, and inserts a blocking_queue entry for
 * CTO visibility.
 *
 * @param {string} persistentTaskId - The ID of the persistent task that was paused
 * @param {string} [pauseReason] - Human-readable reason for the pause
 * @param {string} [bypassRequestId] - Optional bypass request ID that triggered the pause
 * @returns {{ propagated: boolean, blocking_level?: string, plan_auto_paused?: boolean, impact?: object, blocking_queue_id?: string, error?: string }}
 */
export function propagatePauseToPlan(persistentTaskId, pauseReason, bypassRequestId) {
  if (!Database || !persistentTaskId) return { propagated: false };

  let ptDb, plansDb, bypassDb;
  try {
    // Step 1: Read persistent task metadata for plan linkage
    if (!fs.existsSync(PERSISTENT_DB_PATH)) return { propagated: false };

    ptDb = new Database(PERSISTENT_DB_PATH, { readonly: true });
    ptDb.pragma('busy_timeout = 3000');

    const task = ptDb.prepare('SELECT metadata FROM persistent_tasks WHERE id = ?').get(persistentTaskId);
    ptDb.close();
    ptDb = null;

    if (!task?.metadata) return { propagated: false };

    let meta;
    try {
      meta = JSON.parse(task.metadata);
    } catch (_) {
      return { propagated: false };
    }

    const planTaskId = meta.plan_task_id;
    const planId = meta.plan_id;

    // Step 2: If no plan linkage, nothing to propagate
    if (!planTaskId || !planId) return { propagated: false };

    // Step 3: Open plans.db read-write and update plan task status
    if (!fs.existsSync(PLANS_DB_PATH)) return { propagated: false };

    plansDb = new Database(PLANS_DB_PATH);
    plansDb.pragma('journal_mode = WAL');
    plansDb.pragma('busy_timeout = 3000');

    const now = new Date().toISOString();

    // Step 4: Update plan task to 'paused' (only if currently in_progress)
    const updateResult = plansDb.prepare(
      "UPDATE plan_tasks SET status = 'paused', updated_at = ? WHERE id = ? AND status = 'in_progress'"
    ).run(now, planTaskId);

    if (updateResult.changes === 0) {
      // Plan task was not in_progress — check its current status
      const currentTask = plansDb.prepare('SELECT status FROM plan_tasks WHERE id = ?').get(planTaskId);
      if (!currentTask || currentTask.status === 'paused') {
        // Already paused or doesn't exist — still continue to create blocking_queue entry
      } else {
        // Task is in a terminal or non-pausable state, skip propagation
        plansDb.close();
        plansDb = null;
        return { propagated: false };
      }
    } else {
      // Step 5: Record state change for the plan task pause
      plansDb.prepare(
        "INSERT INTO state_changes (id, entity_type, entity_id, field_name, old_value, new_value, changed_at, changed_by) VALUES (?, 'task', ?, 'status', 'in_progress', 'paused', ?, 'pause-propagation')"
      ).run(randomUUID(), planTaskId, now);
    }

    // Step 6: Assess plan impact — check dependencies, gate phase, parallel work
    const downstreamDeps = plansDb.prepare(
      "SELECT blocked_id FROM dependencies WHERE blocker_id = ? AND blocker_type = 'task'"
    ).all(planTaskId);

    const gatePhaseRow = plansDb.prepare(
      'SELECT gate FROM phases WHERE id = (SELECT phase_id FROM plan_tasks WHERE id = ?)'
    ).get(planTaskId);
    const isGatePhase = !!(gatePhaseRow?.gate);

    const parallelWorkRow = plansDb.prepare(
      "SELECT COUNT(*) as cnt FROM plan_tasks WHERE plan_id = ? AND status IN ('in_progress', 'ready') AND id != ?"
    ).get(planId, planTaskId);
    const parallelWorkCount = parallelWorkRow?.cnt ?? 0;
    const hasParallelWork = parallelWorkCount > 0;

    const blockedTaskIds = downstreamDeps.map(d => d.blocked_id);

    // Step 7: Determine blocking level
    // 'plan' level if: (has downstream deps AND no parallel work) OR is in a gate phase
    const blockingLevel = (blockedTaskIds.length > 0 && !hasParallelWork) || isGatePhase
      ? 'plan'
      : 'persistent_task';

    // Step 8: Auto-pause the plan if blocking_level is 'plan'
    let planAutoPaused = false;
    if (blockingLevel === 'plan') {
      const planUpdateResult = plansDb.prepare(
        "UPDATE plans SET status = 'paused', updated_at = ? WHERE id = ? AND status = 'active'"
      ).run(now, planId);

      if (planUpdateResult.changes > 0) {
        plansDb.prepare(
          "INSERT INTO state_changes (id, entity_type, entity_id, field_name, old_value, new_value, changed_at, changed_by) VALUES (?, 'plan', ?, 'status', 'active', 'paused', ?, 'pause-propagation')"
        ).run(randomUUID(), planId, now);
        planAutoPaused = true;
      }
    }

    // Step 9: Read plan title for the blocking_queue entry
    const planRow = plansDb.prepare('SELECT title FROM plans WHERE id = ?').get(planId);
    const planTitle = planRow?.title ?? null;

    plansDb.close();
    plansDb = null;

    // Step 10: Insert into blocking_queue in bypass-requests.db
    const blockingQueueId = 'block-' + randomUUID().slice(0, 12);

    const impactAssessment = JSON.stringify({
      blocked_tasks: blockedTaskIds,
      blocks_phase: blockedTaskIds.length > 0,
      is_gate: isGatePhase,
      parallel_paths_available: hasParallelWork,
    });

    const summary = pauseReason || 'Persistent task paused';

    if (!fs.existsSync(BYPASS_DB_PATH)) {
      // bypass-requests.db is created by agent-tracker — if it doesn't exist yet,
      // skip the blocking_queue write (non-fatal). The entry will be created
      // when submit_bypass_request is called, which always opens the canonical DB.
      return {
        propagated: true,
        blocking_level: blockingLevel,
        plan_auto_paused: planAutoPaused,
        plan_task_id: planTaskId,
        plan_id: planId,
        impact: {
          blocked_tasks: blockedTaskIds,
          blocks_phase: blockedTaskIds.length > 0,
          is_gate: isGatePhase,
          parallel_paths_available: hasParallelWork,
        },
        blocking_queue_id: null,
      };
    }

    bypassDb = new Database(BYPASS_DB_PATH);
    bypassDb.pragma('journal_mode = WAL');
    bypassDb.pragma('busy_timeout = 3000');

    ensureBlockingQueueTable(bypassDb);

    bypassDb.prepare(`
      INSERT INTO blocking_queue (id, bypass_request_id, source_task_type, source_task_id, persistent_task_id, plan_task_id, plan_id, plan_title, blocking_level, impact_assessment, summary, status)
      VALUES (?, ?, 'persistent', ?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(
      blockingQueueId,
      bypassRequestId ?? null,
      persistentTaskId,
      persistentTaskId,
      planTaskId,
      planId,
      planTitle,
      blockingLevel,
      impactAssessment,
      summary,
    );

    bypassDb.close();
    bypassDb = null;

    return {
      propagated: true,
      blocking_level: blockingLevel,
      plan_auto_paused: planAutoPaused,
      plan_task_id: planTaskId,
      plan_id: planId,
      impact: {
        blocked_tasks: blockedTaskIds,
        blocks_phase: blockedTaskIds.length > 0,
        is_gate: isGatePhase,
        parallel_paths_available: hasParallelWork,
      },
      blocking_queue_id: blockingQueueId,
    };
  } catch (e) {
    return { propagated: false, error: e.message };
  } finally {
    try { ptDb?.close(); } catch (_) { /* best-effort */ }
    try { plansDb?.close(); } catch (_) { /* best-effort */ }
    try { bypassDb?.close(); } catch (_) { /* best-effort */ }
  }
}

/**
 * Propagate a persistent task resume back up to the plan layer.
 *
 * Reads the persistent task's metadata for plan linkage. If linked, resumes
 * the plan task, resolves any active blocking_queue entries, and resumes the
 * plan itself if no other plan tasks remain paused.
 *
 * @param {string} persistentTaskId - The ID of the persistent task that was resumed
 * @returns {{ propagated: boolean, plan_resumed?: boolean, blocking_items_resolved?: number, error?: string }}
 */
export function propagateResumeToPlan(persistentTaskId) {
  if (!Database || !persistentTaskId) return { propagated: false };

  let ptDb, plansDb, bypassDb;
  try {
    // Step 1: Read persistent task metadata for plan linkage
    if (!fs.existsSync(PERSISTENT_DB_PATH)) return { propagated: false };

    ptDb = new Database(PERSISTENT_DB_PATH, { readonly: true });
    ptDb.pragma('busy_timeout = 3000');

    const task = ptDb.prepare('SELECT metadata FROM persistent_tasks WHERE id = ?').get(persistentTaskId);
    ptDb.close();
    ptDb = null;

    if (!task?.metadata) return { propagated: false };

    let meta;
    try {
      meta = JSON.parse(task.metadata);
    } catch (_) {
      return { propagated: false };
    }

    const planTaskId = meta.plan_task_id;
    const planId = meta.plan_id;

    // Step 2: If no plan linkage, nothing to propagate
    if (!planTaskId || !planId) return { propagated: false };

    // Step 3: Open plans.db read-write
    if (!fs.existsSync(PLANS_DB_PATH)) return { propagated: false };

    plansDb = new Database(PLANS_DB_PATH);
    plansDb.pragma('journal_mode = WAL');
    plansDb.pragma('busy_timeout = 3000');

    const now = new Date().toISOString();

    // Update plan task back to 'in_progress' (only if currently paused)
    const updateResult = plansDb.prepare(
      "UPDATE plan_tasks SET status = 'in_progress', updated_at = ? WHERE id = ? AND status = 'paused'"
    ).run(now, planTaskId);

    if (updateResult.changes > 0) {
      // Record state change for plan task resume
      plansDb.prepare(
        "INSERT INTO state_changes (id, entity_type, entity_id, field_name, old_value, new_value, changed_at, changed_by) VALUES (?, 'task', ?, 'status', 'paused', 'in_progress', ?, 'pause-propagation')"
      ).run(randomUUID(), planTaskId, now);
    }

    // Check whether the plan itself is paused
    const planRow = plansDb.prepare('SELECT status FROM plans WHERE id = ?').get(planId);
    let planResumed = false;

    if (planRow?.status === 'paused') {
      // Check if any OTHER plan tasks are still paused
      const otherPausedRow = plansDb.prepare(
        "SELECT COUNT(*) as cnt FROM plan_tasks WHERE plan_id = ? AND status = 'paused' AND id != ?"
      ).get(planId, planTaskId);
      const otherPausedCount = otherPausedRow?.cnt ?? 0;

      if (otherPausedCount === 0) {
        // No other paused tasks — resume the plan
        const planUpdateResult = plansDb.prepare(
          "UPDATE plans SET status = 'active', updated_at = ? WHERE id = ? AND status = 'paused'"
        ).run(now, planId);

        if (planUpdateResult.changes > 0) {
          plansDb.prepare(
            "INSERT INTO state_changes (id, entity_type, entity_id, field_name, old_value, new_value, changed_at, changed_by) VALUES (?, 'plan', ?, 'status', 'paused', 'active', ?, 'pause-propagation')"
          ).run(randomUUID(), planId, now);
          planResumed = true;
        }
      }
    }

    plansDb.close();
    plansDb = null;

    // Step 4: Resolve active blocking_queue items in bypass-requests.db
    let blockingItemsResolved = 0;

    if (fs.existsSync(BYPASS_DB_PATH)) {
      bypassDb = new Database(BYPASS_DB_PATH);
      bypassDb.pragma('journal_mode = WAL');
      bypassDb.pragma('busy_timeout = 3000');
      ensureBlockingQueueTable(bypassDb);

      const resolveResult = bypassDb.prepare(
        "UPDATE blocking_queue SET status = 'resolved', resolved_at = datetime('now') WHERE persistent_task_id = ? AND status = 'active'"
      ).run(persistentTaskId);

      blockingItemsResolved = resolveResult.changes;

      bypassDb.close();
      bypassDb = null;
    }

    return {
      propagated: true,
      plan_resumed: planResumed,
      blocking_items_resolved: blockingItemsResolved,
    };
  } catch (e) {
    return { propagated: false, error: e.message };
  } finally {
    try { ptDb?.close(); } catch (_) { /* best-effort */ }
    try { plansDb?.close(); } catch (_) { /* best-effort */ }
    try { bypassDb?.close(); } catch (_) { /* best-effort */ }
  }
}

/**
 * Assess the current blocking state of a plan.
 *
 * Read-only function that returns a snapshot of which plan tasks are paused,
 * what downstream work is blocked, and whether the plan is fully or partially
 * blocked.
 *
 * @param {string} planId - The ID of the plan to assess
 * @returns {{ fully_blocked: boolean, partially_blocked: boolean, paused_tasks: Array, available_parallel_work: Array, blocking_items: Array, error?: string }}
 */
export function assessPlanBlocking(planId) {
  const safe = { fully_blocked: false, partially_blocked: false, paused_tasks: [], available_parallel_work: [], blocking_items: [] };

  if (!Database || !planId) return safe;

  let plansDb, bypassDb;
  try {
    // Step 1: Open plans.db read-only
    if (!fs.existsSync(PLANS_DB_PATH)) return safe;

    plansDb = new Database(PLANS_DB_PATH, { readonly: true });
    plansDb.pragma('busy_timeout = 3000');

    // Step 2: Get all paused plan tasks for this plan
    const pausedTasks = plansDb.prepare(
      "SELECT id, title, phase_id, persistent_task_id FROM plan_tasks WHERE plan_id = ? AND status = 'paused'"
    ).all(planId);

    // Step 3: For each paused task, find downstream dependencies
    const pausedTasksWithDeps = pausedTasks.map(pt => {
      const downstreamDeps = plansDb.prepare(
        "SELECT blocked_id FROM dependencies WHERE blocker_id = ? AND blocker_type = 'task'"
      ).all(pt.id);
      return {
        ...pt,
        blocked_task_ids: downstreamDeps.map(d => d.blocked_id),
      };
    });

    // Step 4: Get available parallel work (tasks in progress or ready)
    const availableWork = plansDb.prepare(
      "SELECT id, title, status, phase_id FROM plan_tasks WHERE plan_id = ? AND status IN ('in_progress', 'ready')"
    ).all(planId);

    plansDb.close();
    plansDb = null;

    // Step 5: Get active blocking_queue items for this plan from bypass-requests.db
    let blockingItems = [];
    if (fs.existsSync(BYPASS_DB_PATH)) {
      bypassDb = new Database(BYPASS_DB_PATH, { readonly: true });
      bypassDb.pragma('busy_timeout = 3000');
      try {
        // Attempt SELECT directly — table may not exist yet on read-only connections.
        // Silently return empty array if the table is absent (non-fatal).
        blockingItems = bypassDb.prepare(
          "SELECT id, persistent_task_id, plan_task_id, blocking_level, impact_assessment, summary, created_at FROM blocking_queue WHERE plan_id = ? AND status = 'active'"
        ).all(planId);
      } catch (_) {
        // Table does not exist yet — return empty array, non-fatal
      }
      bypassDb.close();
      bypassDb = null;
    }

    // Step 6: Determine fully_blocked vs partially_blocked
    const hasParallelWork = availableWork.length > 0;
    const fullyBlocked = pausedTasksWithDeps.length > 0 && !hasParallelWork;
    const partiallyBlocked = pausedTasksWithDeps.length > 0 && hasParallelWork;

    return {
      fully_blocked: fullyBlocked,
      partially_blocked: partiallyBlocked,
      paused_tasks: pausedTasksWithDeps,
      available_parallel_work: availableWork,
      blocking_items: blockingItems,
    };
  } catch (e) {
    return { ...safe, error: e.message };
  } finally {
    try { plansDb?.close(); } catch (_) { /* best-effort */ }
    try { bypassDb?.close(); } catch (_) { /* best-effort */ }
  }
}
