/**
 * Cross-Entity Dependency Satisfier — shared logic invoked by PostToolUse
 * hooks on every entity completion (todo, persistent, plan_task, plan).
 *
 * Exports:
 *   - satisfyCompletedBlocker({entity_type, entity_id, completedBy?}) — marks all
 *     active deps where this entity is the blocker as 'satisfied'. Returns
 *     the list of newly-unblocked entities.
 *   - cascadeUnblock(unblocked) — for each newly-unblocked entity, checks
 *     whether ALL its active deps are now satisfied, and if so:
 *       * todo → drainQueue() (session-queue gate picks it up)
 *       * persistent (in 'draft') → activate it (DB write + monitor enqueued via spawner)
 *       * plan_task (paused/blocked) → set status='pending' so plan-manager picks it up
 *     Returns a summary of actions taken.
 *
 * Idempotent. Fail-open: any DB unavailability is logged but never throws.
 * Logs to .claude/session-queue.log.
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';

const PROJECT_DIR = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const WS_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'workstream.db');
const TODO_DB_PATH = path.join(PROJECT_DIR, '.claude', 'todo.db');
const PERSISTENT_TASKS_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
const PLANS_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'plans.db');
const LOG_FILE = path.join(PROJECT_DIR, '.claude', 'session-queue.log');

function log(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [cross-dep-satisfier] ${message}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    /* non-fatal */
  }
}

function newChangeId() {
  return `wsc-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Mark all active queue_dependencies rows where (entity_type, entity_id) is
 * the blocker as 'satisfied'. Returns the list of unblocked rows so the caller
 * can cascade further actions.
 */
export function satisfyCompletedBlocker({ entity_type, entity_id, completedBy }) {
  if (!entity_type || !entity_id) return { satisfied: 0, unblocked: [] };
  if (!fs.existsSync(WS_DB_PATH)) return { satisfied: 0, unblocked: [] };

  let db;
  try {
    db = new Database(WS_DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
  } catch (err) {
    log(`Could not open workstream.db: ${err.message}`);
    return { satisfied: 0, unblocked: [] };
  }

  let unblocked = [];
  try {
    const rows = db
      .prepare(
        "SELECT id, blocked_entity_type, blocked_task_id, blocker_task_id FROM queue_dependencies WHERE blocker_entity_type = ? AND blocker_task_id = ? AND status = 'active'"
      )
      .all(entity_type, entity_id);

    if (rows.length === 0) return { satisfied: 0, unblocked: [] };

    const ts = new Date().toISOString();
    const tx = db.transaction(() => {
      for (const row of rows) {
        const result = db
          .prepare(
            "UPDATE queue_dependencies SET status = 'satisfied', satisfied_at = ? WHERE id = ? AND status = 'active'"
          )
          .run(ts, row.id);
        if (result.changes > 0) {
          unblocked.push({
            entity_type: row.blocked_entity_type,
            entity_id: row.blocked_task_id,
            dep_id: row.id,
          });
          try {
            db.prepare(
              'INSERT INTO workstream_changes (id, change_type, queue_id, task_id, details, reasoning, agent_id, created_at) VALUES (?, ?, NULL, ?, ?, ?, NULL, ?)'
            ).run(
              newChangeId(),
              'dependency_satisfied',
              row.blocked_task_id,
              JSON.stringify({ dependency_id: row.id, blocker_entity_type: entity_type, blocker_task_id: entity_id }),
              `Blocker ${entity_type}:${entity_id} completed${completedBy ? ` (via ${completedBy})` : ''}`,
              ts
            );
          } catch (err) {
            // Non-fatal — we already marked the dep satisfied.
            log(`Could not record workstream change for dep ${row.id}: ${err.message}`);
          }
        }
      }
    });
    tx();

    log(
      `Satisfied ${unblocked.length} dep(s) where blocker=${entity_type}:${entity_id}; unblocked: ${unblocked.map((u) => `${u.entity_type}:${u.entity_id}`).join(', ')}`
    );
  } catch (err) {
    log(`satisfyCompletedBlocker error: ${err.message}`);
  } finally {
    db.close();
  }

  return { satisfied: unblocked.length, unblocked };
}

/**
 * For each newly-unblocked entity, check whether ALL its active deps are now
 * satisfied. If yes, take the appropriate action by entity type.
 */
export async function cascadeUnblock(unblocked) {
  const actions = { todoDrains: 0, persistentActivations: [], planTaskUnblocks: [] };
  if (!unblocked || unblocked.length === 0) return actions;
  if (!fs.existsSync(WS_DB_PATH)) return actions;

  // Dedupe — multiple deps can point to the same blocked entity.
  const seen = new Set();
  const unique = unblocked.filter((u) => {
    const key = `${u.entity_type}:${u.entity_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  let wsDb;
  try {
    wsDb = new Database(WS_DB_PATH, { readonly: true });
  } catch (err) {
    log(`Could not open workstream.db (readonly) for cascade: ${err.message}`);
    return actions;
  }

  const fullySatisfied = [];
  try {
    for (const u of unique) {
      const remaining = wsDb
        .prepare(
          "SELECT COUNT(*) AS n FROM queue_dependencies WHERE blocked_entity_type = ? AND blocked_task_id = ? AND status = 'active'"
        )
        .get(u.entity_type, u.entity_id);
      if (!remaining || remaining.n === 0) {
        fullySatisfied.push(u);
      } else {
        log(`${u.entity_type}:${u.entity_id} still has ${remaining.n} active dep(s) remaining`);
      }
    }
  } finally {
    wsDb.close();
  }

  if (fullySatisfied.length === 0) return actions;

  // Bucket by entity type.
  const todoIds = [];
  const persistentIds = [];
  const planTaskIds = [];
  for (const u of fullySatisfied) {
    if (u.entity_type === 'todo') todoIds.push(u.entity_id);
    else if (u.entity_type === 'persistent') persistentIds.push(u.entity_id);
    else if (u.entity_type === 'plan_task') planTaskIds.push(u.entity_id);
  }

  // ── todo entities: nudge the session-queue drain so the gate picks them up.
  if (todoIds.length > 0) {
    try {
      const { drainQueue } = await import('./session-queue.js');
      drainQueue();
      actions.todoDrains = todoIds.length;
      log(`Drained queue for ${todoIds.length} unblocked todo task(s)`);
    } catch (err) {
      log(`drainQueue failed for unblocked todos: ${err.message}`);
    }
  }

  // ── persistent entities in 'draft': activate them.
  if (persistentIds.length > 0 && fs.existsSync(PERSISTENT_TASKS_DB_PATH)) {
    let ptDb;
    try {
      ptDb = new Database(PERSISTENT_TASKS_DB_PATH);
      ptDb.pragma('journal_mode = WAL');
      ptDb.pragma('busy_timeout = 5000');
      const ts = new Date().toISOString();
      for (const id of persistentIds) {
        try {
          const result = ptDb
            .prepare(
              "UPDATE persistent_tasks SET status = 'active', activated_at = ? WHERE id = ? AND status = 'draft'"
            )
            .run(ts, id);
          if (result.changes > 0) {
            // Record the activation event so monitoring tools see it.
            try {
              ptDb
                .prepare(
                  "INSERT INTO events (id, persistent_task_id, event_type, details, created_at) VALUES (?, ?, ?, ?, ?)"
                )
                .run(
                  `evt-${crypto.randomBytes(4).toString('hex')}`,
                  id,
                  'auto_activated',
                  JSON.stringify({ reason: 'cross_entity_deps_satisfied' }),
                  ts
                );
            } catch {
              /* events table may not exist on very old DBs */
            }
            actions.persistentActivations.push(id);
            log(`Auto-activated persistent task ${id} (deps satisfied)`);

            // Enqueue the monitor session for the newly-activated persistent task.
            // Mirrors the PostToolUse hook persistent-task-spawner.js behavior so
            // we don't depend on it firing for activations we performed directly.
            await enqueuePersistentMonitor(id);
          }
        } catch (err) {
          log(`Could not auto-activate persistent ${id}: ${err.message}`);
        }
      }
    } catch (err) {
      log(`Could not open persistent-tasks.db: ${err.message}`);
    } finally {
      ptDb?.close();
    }
  }

  // ── plan_task entities (paused / blocked / pending): set status='pending'
  // so the plan-manager's next get_spawn_ready_tasks() cycle promotes them.
  if (planTaskIds.length > 0 && fs.existsSync(PLANS_DB_PATH)) {
    let plansDb;
    try {
      plansDb = new Database(PLANS_DB_PATH);
      plansDb.pragma('journal_mode = WAL');
      plansDb.pragma('busy_timeout = 5000');
      for (const id of planTaskIds) {
        try {
          const result = plansDb
            .prepare(
              "UPDATE plan_tasks SET status = 'pending' WHERE id = ? AND status IN ('paused','blocked')"
            )
            .run(id);
          if (result.changes > 0) {
            actions.planTaskUnblocks.push(id);
            log(`Promoted plan_task ${id} → 'pending' (deps satisfied)`);
          }
        } catch (err) {
          log(`Could not unblock plan_task ${id}: ${err.message}`);
        }
      }
    } catch (err) {
      log(`Could not open plans.db: ${err.message}`);
    } finally {
      plansDb?.close();
    }
  }

  return actions;
}

/**
 * Enqueue a persistent-task monitor session for `persistentTaskId`. This
 * delegates to session-queue.js so it picks up the standard spawning rules
 * (priority, lane, model, agent definition). Best-effort — failures logged
 * but never thrown.
 */
async function enqueuePersistentMonitor(persistentTaskId) {
  try {
    const sq = await import('./session-queue.js');
    const enqueue = sq.enqueueSession || sq.default?.enqueueSession;
    if (typeof enqueue !== 'function') {
      log(`session-queue.js does not export enqueueSession — cannot spawn monitor for ${persistentTaskId}`);
      return;
    }

    // Match the typical persistent-monitor spawn used by persistent-task-spawner.js.
    enqueue({
      agent: 'persistent-monitor',
      agentType: 'persistent-monitor',
      lane: 'persistent',
      priority: 'critical',
      source: 'cross-dep-auto-activate',
      prompt: `Persistent task ${persistentTaskId} was auto-activated after its declared dependencies completed. Begin the standard monitoring cycle: read the task with get_persistent_task, plan child work via task creation, and proceed.`,
      metadata: { persistentTaskId, auto_activated_via: 'cross_dep_satisfier' },
    });
  } catch (err) {
    log(`enqueuePersistentMonitor failed for ${persistentTaskId}: ${err.message}`);
  }
}

/**
 * Convenience wrapper: satisfy a completed blocker AND cascade unblock in one call.
 */
export async function satisfyAndCascade({ entity_type, entity_id, completedBy }) {
  const { satisfied, unblocked } = satisfyCompletedBlocker({ entity_type, entity_id, completedBy });
  if (unblocked.length === 0) return { satisfied, unblocked, actions: null };
  const actions = await cascadeUnblock(unblocked);
  return { satisfied, unblocked, actions };
}
