/**
 * Cross-Entity Dependency Helpers — shared by creator MCP servers
 * (todo-db, persistent-task, plan-orchestrator) so they can declare
 * cross-entity dependencies inline at create time without re-implementing
 * workstream/server.ts validation logic.
 *
 * Writes directly to workstream.db. Lightweight by design:
 *  - validates the blocker entity exists in its source DB (best-effort)
 *  - inserts a `queue_dependencies` row
 *  - records a workstream_changes audit entry
 *  - on already-completed blocker, inserts as 'satisfied' immediately
 *
 * No cycle detection here — newly-created entities cannot already
 * participate in a dependency cycle. The fuller cycle-detection lives
 * in workstream/server.ts handleAddDependency for runtime adds.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import Database from 'better-sqlite3';

const PROJECT_DIR = path.resolve(process.env['CLAUDE_PROJECT_DIR'] || process.cwd());
const WS_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'workstream.db');
const TODO_DB_PATH = path.join(PROJECT_DIR, '.claude', 'todo.db');
const PERSISTENT_TASKS_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
const PLANS_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'plans.db');

export type CrossEntityType = 'todo' | 'persistent' | 'plan_task' | 'plan';

export interface DependsOnEntry {
  entity_type: CrossEntityType;
  entity_id: string;
  reasoning?: string;
}

export interface AddDependenciesResult {
  added: Array<{
    dependency_id: string;
    blocker_entity_type: CrossEntityType;
    blocker_entity_id: string;
    status: 'active' | 'satisfied';
  }>;
  errors: string[];
}

function now(): string {
  return new Date().toISOString();
}

function newDepId(): string {
  return `dep-${crypto.randomBytes(4).toString('hex')}`;
}

function newChangeId(): string {
  return `wsc-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Read the current status of an entity from its source DB. Returns null when
 * the entity or its DB is missing (caller decides how to handle).
 */
function readEntityStatus(entity_type: CrossEntityType, entity_id: string): string | null {
  try {
    if (entity_type === 'todo') {
      if (!fs.existsSync(TODO_DB_PATH)) return null;
      const db = new Database(TODO_DB_PATH, { readonly: true });
      try {
        const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(entity_id) as
          | { status: string }
          | undefined;
        return row?.status ?? null;
      } finally {
        db.close();
      }
    }
    if (entity_type === 'persistent') {
      if (!fs.existsSync(PERSISTENT_TASKS_DB_PATH)) return null;
      const db = new Database(PERSISTENT_TASKS_DB_PATH, { readonly: true });
      try {
        const row = db
          .prepare('SELECT status FROM persistent_tasks WHERE id = ?')
          .get(entity_id) as { status: string } | undefined;
        return row?.status ?? null;
      } finally {
        db.close();
      }
    }
    if (entity_type === 'plan_task') {
      if (!fs.existsSync(PLANS_DB_PATH)) return null;
      const db = new Database(PLANS_DB_PATH, { readonly: true });
      try {
        const row = db.prepare('SELECT status FROM plan_tasks WHERE id = ?').get(entity_id) as
          | { status: string }
          | undefined;
        return row?.status ?? null;
      } finally {
        db.close();
      }
    }
    if (entity_type === 'plan') {
      if (!fs.existsSync(PLANS_DB_PATH)) return null;
      const db = new Database(PLANS_DB_PATH, { readonly: true });
      try {
        const row = db.prepare('SELECT status FROM plans WHERE id = ?').get(entity_id) as
          | { status: string }
          | undefined;
        return row?.status ?? null;
      } finally {
        db.close();
      }
    }
  } catch {
    return null;
  }
  return null;
}

function isSatisfyingTerminalStatus(entity_type: CrossEntityType, status: string): boolean {
  if (entity_type === 'todo') return status === 'completed';
  if (entity_type === 'persistent') return status === 'completed';
  if (entity_type === 'plan_task') return status === 'completed' || status === 'skipped';
  if (entity_type === 'plan') return status === 'signed_off' || status === 'completed';
  return false;
}

/**
 * Insert cross-entity dependencies for a newly-created entity. Blockers
 * already in a terminal state insert as 'satisfied'. Missing blockers are
 * reported in `errors` but other entries still apply (best-effort write).
 *
 * `'plan'` as a blocker_entity_type is supported provided workstream.db
 * has been migrated to allow it (see workstream/server.ts migration).
 */
export function addDependenciesForNewEntity(opts: {
  blocked_entity_type: CrossEntityType;
  blocked_entity_id: string;
  dependsOn: DependsOnEntry[];
  createdBy: string;
}): AddDependenciesResult {
  const result: AddDependenciesResult = { added: [], errors: [] };

  if (!opts.dependsOn || opts.dependsOn.length === 0) return result;

  // 'plan' is NOT a valid blocked entity (workstream CHECK constraint).
  if (opts.blocked_entity_type === 'plan') {
    result.errors.push("'plan' cannot be a blocked entity — depend at plan_task granularity instead");
    return result;
  }

  if (!fs.existsSync(WS_DB_PATH)) {
    // workstream.db not yet initialized — surface the issue so the caller
    // can decide whether to rollback or proceed.
    result.errors.push(
      'workstream.db not found — cannot record dependencies. Ensure workstream MCP server has run at least once.'
    );
    return result;
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(WS_DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');

    const ts = now();

    for (const dep of opts.dependsOn) {
      const reasoning =
        dep.reasoning && dep.reasoning.trim().length >= 10
          ? dep.reasoning
          : `Declared at create-time on ${opts.blocked_entity_type}:${opts.blocked_entity_id}`;

      // Skip self-references silently.
      if (
        dep.entity_type === opts.blocked_entity_type &&
        dep.entity_id === opts.blocked_entity_id
      ) {
        result.errors.push(`Skipped self-reference ${dep.entity_type}:${dep.entity_id}`);
        continue;
      }

      // Best-effort blocker existence check. Missing entity is non-fatal at
      // create time — record the dep anyway so the satisfier still cascades
      // if the blocker shows up later (e.g., race between creator calls).
      const blockerStatus = readEntityStatus(dep.entity_type, dep.entity_id);

      // Dedup — skip if an active dep already exists for this exact pair.
      const existing = db
        .prepare(
          "SELECT id FROM queue_dependencies WHERE blocked_entity_type = ? AND blocked_task_id = ? AND blocker_entity_type = ? AND blocker_task_id = ? AND status = 'active'"
        )
        .get(opts.blocked_entity_type, opts.blocked_entity_id, dep.entity_type, dep.entity_id) as
        | { id: string }
        | undefined;

      if (existing) {
        result.added.push({
          dependency_id: existing.id,
          blocker_entity_type: dep.entity_type,
          blocker_entity_id: dep.entity_id,
          status: 'active',
        });
        continue;
      }

      const depId = newDepId();
      const depStatus: 'active' | 'satisfied' =
        blockerStatus && isSatisfyingTerminalStatus(dep.entity_type, blockerStatus)
          ? 'satisfied'
          : 'active';

      try {
        db.prepare(
          'INSERT INTO queue_dependencies (id, blocked_queue_id, blocked_task_id, blocked_entity_type, blocker_queue_id, blocker_task_id, blocker_entity_type, status, created_by, reasoning, pause_action, created_at, satisfied_at) VALUES (?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?, ?)'
        ).run(
          depId,
          opts.blocked_entity_id,
          opts.blocked_entity_type,
          dep.entity_id,
          dep.entity_type,
          depStatus,
          opts.createdBy,
          reasoning,
          ts,
          depStatus === 'satisfied' ? ts : null
        );

        db.prepare(
          'INSERT INTO workstream_changes (id, change_type, queue_id, task_id, details, reasoning, agent_id, created_at) VALUES (?, ?, NULL, ?, ?, ?, NULL, ?)'
        ).run(
          newChangeId(),
          'dependency_added',
          opts.blocked_entity_id,
          JSON.stringify({
            dependency_id: depId,
            blocker: { entity_type: dep.entity_type, entity_id: dep.entity_id },
            blocked: {
              entity_type: opts.blocked_entity_type,
              entity_id: opts.blocked_entity_id,
            },
            dep_status: depStatus,
            inline_create: true,
          }),
          reasoning,
          ts
        );

        result.added.push({
          dependency_id: depId,
          blocker_entity_type: dep.entity_type,
          blocker_entity_id: dep.entity_id,
          status: depStatus,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(`${dep.entity_type}:${dep.entity_id} — ${message}`);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(`Failed to open workstream.db: ${message}`);
  } finally {
    db?.close();
  }

  return result;
}

/**
 * Returns true when every active dep blocking `(entity_type, entity_id)` has
 * a blocker in a satisfying terminal state. Used by the persistent-task
 * activation refusal gate. Fail-open on DB unavailability — gate only blocks
 * when it can prove deps are unmet.
 */
export function areCrossEntityDepsMet(
  entity_type: CrossEntityType,
  entity_id: string
): { metAll: boolean; blockers: Array<{ entity_type: string; entity_id: string; status: string | null }> } {
  if (!fs.existsSync(WS_DB_PATH)) return { metAll: true, blockers: [] };

  let db: Database.Database | null = null;
  try {
    db = new Database(WS_DB_PATH, { readonly: true });
    const rows = db
      .prepare(
        "SELECT blocker_entity_type, blocker_task_id FROM queue_dependencies WHERE blocked_entity_type = ? AND blocked_task_id = ? AND status = 'active'"
      )
      .all(entity_type, entity_id) as Array<{ blocker_entity_type: string; blocker_task_id: string }>;

    if (rows.length === 0) return { metAll: true, blockers: [] };

    const unmet: Array<{ entity_type: string; entity_id: string; status: string | null }> = [];
    for (const r of rows) {
      const status = readEntityStatus(r.blocker_entity_type as CrossEntityType, r.blocker_task_id);
      if (!status || !isSatisfyingTerminalStatus(r.blocker_entity_type as CrossEntityType, status)) {
        unmet.push({
          entity_type: r.blocker_entity_type,
          entity_id: r.blocker_task_id,
          status,
        });
      }
    }
    return { metAll: unmet.length === 0, blockers: unmet };
  } catch {
    return { metAll: true, blockers: [] };
  } finally {
    db?.close();
  }
}

/**
 * Zod-friendly shape — exported so creator schemas can import it directly.
 * Each creator's CreateXArgsSchema adds `depends_on: z.array(DependsOnSchema).optional()`.
 *
 * Kept as a plain type here. Each consumer wires its own z.object(...) so this
 * module stays free of a hard zod dependency at compile time.
 */
export const DEPENDS_ON_ENTITY_TYPES = ['todo', 'persistent', 'plan_task', 'plan'] as const;
