#!/usr/bin/env node
/**
 * Workstream Manager MCP Server
 *
 * Manages queue-level dependencies, priority reordering, and workstream
 * change history. Allows the workstream-manager agent to block tasks until
 * their dependencies complete, reorder queued items, and audit all changes.
 *
 * Database: .claude/state/workstream.db (SQLite, WAL mode)
 * Reads:    .claude/state/session-queue.db (read-only), .claude/todo.db (read-only)
 * Tier: 2 (stateful, per-session stdio)
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (stdio MCP)
 *
 * @version 1.0.0
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import Database from 'better-sqlite3';
import { openReadonlyDb } from '../shared/readonly-db.js';
import { McpServer, type AnyToolHandler } from '../shared/server.js';
import {
  AddDependencyArgsSchema,
  RemoveDependencyArgsSchema,
  ListDependenciesArgsSchema,
  ListDependenciesForEntityArgsSchema,
  GetQueueContextArgsSchema,
  ReorderItemArgsSchema,
  RecordAssessmentArgsSchema,
  GetChangeLogArgsSchema,
  RegisterSupersessionArgsSchema,
  ListSupersessionsArgsSchema,
  type AddDependencyArgs,
  type RemoveDependencyArgs,
  type ListDependenciesArgs,
  type ListDependenciesForEntityArgs,
  type GetQueueContextArgs,
  type ReorderItemArgs,
  type RecordAssessmentArgs,
  type GetChangeLogArgs,
  type RegisterSupersessionArgs,
  type ListSupersessionsArgs,
  type QueueDependencyRecord,
  type DependencyListItem,
  type QueueItemContext,
  type ErrorResult,
  type AddDependencyResult,
  type RemoveDependencyResult,
  type ListDependenciesResult,
  type ListDependenciesForEntityResult,
  type GetQueueContextResult,
  type ReorderItemResult,
  type RecordAssessmentResult,
  type GetChangeLogResult,
  type ChangeLogItem,
  type RegisterSupersessionResult,
  type RegisterSupersessionExistsResult,
  type ListSupersessionsResult,
  type TaskSupersessionRecord,
  type EntityType,
} from './types.js';

// ============================================================================
// Configuration
// ============================================================================

const PROJECT_DIR = path.resolve(process.env['CLAUDE_PROJECT_DIR'] || process.cwd());
const DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'workstream.db');
const SESSION_QUEUE_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'session-queue.db');
const TODO_DB_PATH = path.join(PROJECT_DIR, '.claude', 'todo.db');
const PERSISTENT_TASKS_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
const PLANS_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'plans.db');

// ============================================================================
// Database Schema
// ============================================================================

const SCHEMA = `
CREATE TABLE IF NOT EXISTS queue_dependencies (
  id TEXT PRIMARY KEY,
  blocked_queue_id TEXT,
  blocked_task_id TEXT NOT NULL,
  blocked_entity_type TEXT NOT NULL DEFAULT 'todo' CHECK (blocked_entity_type IN ('todo','persistent','plan_task')),
  blocker_queue_id TEXT,
  blocker_task_id TEXT NOT NULL,
  blocker_entity_type TEXT NOT NULL DEFAULT 'todo' CHECK (blocker_entity_type IN ('todo','persistent','plan_task','plan')),
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  pause_action TEXT,
  created_at TEXT NOT NULL,
  satisfied_at TEXT,
  UNIQUE(blocked_entity_type, blocked_task_id, blocker_entity_type, blocker_task_id)
);
CREATE INDEX IF NOT EXISTS idx_dep_blocked_entity ON queue_dependencies(blocked_entity_type, blocked_task_id, status);
CREATE INDEX IF NOT EXISTS idx_dep_blocker_entity ON queue_dependencies(blocker_entity_type, blocker_task_id, status);

CREATE TABLE IF NOT EXISTS workstream_changes (
  id TEXT PRIMARY KEY,
  change_type TEXT NOT NULL,
  queue_id TEXT,
  task_id TEXT,
  details TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  agent_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wsc_created ON workstream_changes(created_at);

CREATE TABLE IF NOT EXISTS task_supersessions (
  id TEXT PRIMARY KEY,
  original_task_id TEXT NOT NULL,
  superseding_task_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE(original_task_id, superseding_task_id)
);
CREATE INDEX IF NOT EXISTS idx_super_original ON task_supersessions(original_task_id, status);
CREATE INDEX IF NOT EXISTS idx_super_superseding ON task_supersessions(superseding_task_id, status);
`;

// ============================================================================
// Database Management
// ============================================================================

let _db: Database.Database | null = null;

/**
 * Idempotent migration to extend queue_dependencies with cross-entity columns.
 * Adds blocked_entity_type, blocker_entity_type, pause_action columns when missing,
 * and broadens the UNIQUE constraint to include both entity types. The broaden
 * step uses a shadow-table swap because SQLite cannot ALTER a UNIQUE constraint.
 */
function migrateCrossEntityDeps(db: Database.Database): void {
  // Step 1: add missing columns (idempotent — PRAGMA table_info())
  const cols = db.prepare('PRAGMA table_info(queue_dependencies)').all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));

  if (!colNames.has('blocked_entity_type')) {
    db.exec(
      `ALTER TABLE queue_dependencies ADD COLUMN blocked_entity_type TEXT NOT NULL DEFAULT 'todo' CHECK (blocked_entity_type IN ('todo','persistent','plan_task'))`
    );
  }
  if (!colNames.has('blocker_entity_type')) {
    db.exec(
      `ALTER TABLE queue_dependencies ADD COLUMN blocker_entity_type TEXT NOT NULL DEFAULT 'todo' CHECK (blocker_entity_type IN ('todo','persistent','plan_task'))`
    );
  }
  if (!colNames.has('pause_action')) {
    db.exec(`ALTER TABLE queue_dependencies ADD COLUMN pause_action TEXT`);
  }

  // Step 2: rebuild via shadow-table swap when EITHER the legacy narrow UNIQUE
  // is still present OR the blocker_entity_type CHECK constraint does not yet
  // include 'plan'. SQLite cannot ALTER a CHECK/UNIQUE in place, so both
  // extensions share one swap path. Idempotent — swap is skipped when the
  // table already matches the canonical schema.
  const tableDef = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='queue_dependencies'")
    .get() as { sql: string } | undefined;

  if (tableDef) {
    const hasNewUnique = /UNIQUE\s*\(\s*blocked_entity_type\s*,\s*blocked_task_id\s*,\s*blocker_entity_type\s*,\s*blocker_task_id\s*\)/i.test(
      tableDef.sql
    );
    const hasOldUnique = /UNIQUE\s*\(\s*blocked_task_id\s*,\s*blocker_task_id\s*\)/i.test(
      tableDef.sql
    );
    // True only when the blocker_entity_type CHECK explicitly lists 'plan'.
    // 'plan' appears last in the new schema's IN(...) list, so we look for the
    // distinctive `'plan_task','plan'` substring to disambiguate from 'plan_task'.
    const hasPlanBlocker = /'plan_task'\s*,\s*'plan'/i.test(tableDef.sql);

    const needsRebuild = (hasOldUnique && !hasNewUnique) || !hasPlanBlocker;

    if (needsRebuild) {
      const swap = db.transaction(() => {
        db.exec(`
          CREATE TABLE queue_dependencies_new (
            id TEXT PRIMARY KEY,
            blocked_queue_id TEXT,
            blocked_task_id TEXT NOT NULL,
            blocked_entity_type TEXT NOT NULL DEFAULT 'todo' CHECK (blocked_entity_type IN ('todo','persistent','plan_task')),
            blocker_queue_id TEXT,
            blocker_task_id TEXT NOT NULL,
            blocker_entity_type TEXT NOT NULL DEFAULT 'todo' CHECK (blocker_entity_type IN ('todo','persistent','plan_task','plan')),
            status TEXT NOT NULL DEFAULT 'active',
            created_by TEXT NOT NULL,
            reasoning TEXT NOT NULL,
            pause_action TEXT,
            created_at TEXT NOT NULL,
            satisfied_at TEXT,
            UNIQUE(blocked_entity_type, blocked_task_id, blocker_entity_type, blocker_task_id)
          )
        `);
        db.exec(`
          INSERT INTO queue_dependencies_new
            (id, blocked_queue_id, blocked_task_id, blocked_entity_type, blocker_queue_id, blocker_task_id, blocker_entity_type, status, created_by, reasoning, pause_action, created_at, satisfied_at)
          SELECT
            id, blocked_queue_id, blocked_task_id, blocked_entity_type, blocker_queue_id, blocker_task_id, blocker_entity_type, status, created_by, reasoning, pause_action, created_at, satisfied_at
          FROM queue_dependencies
        `);
        db.exec('DROP TABLE queue_dependencies');
        db.exec('ALTER TABLE queue_dependencies_new RENAME TO queue_dependencies');
      });
      swap();
    }
  }

  // Step 3: composite indexes (idempotent). Drop legacy narrow indexes first if present.
  db.exec('DROP INDEX IF EXISTS idx_dep_blocked');
  db.exec('DROP INDEX IF EXISTS idx_dep_blocker');
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_dep_blocked_entity ON queue_dependencies(blocked_entity_type, blocked_task_id, status)'
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_dep_blocker_entity ON queue_dependencies(blocker_entity_type, blocker_task_id, status)'
  );
}

function ensureDb(): Database.Database {
  if (_db) return _db;

  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('busy_timeout = 5000');
  _db.exec(SCHEMA);
  migrateCrossEntityDeps(_db);
  return _db;
}

// ============================================================================
// Helper Functions
// ============================================================================

function now(): string {
  return new Date().toISOString();
}

function newDepId(): string {
  return `dep-${crypto.randomBytes(4).toString('hex')}`;
}

function newChangeId(): string {
  return `wsc-${crypto.randomBytes(4).toString('hex')}`;
}

// ============================================================================
// Entity Validation & Pause-If-Running Helpers
// ============================================================================

interface EntityRef {
  entity_type: EntityType;
  entity_id: string;
}

function entityKey(ref: EntityRef): string {
  return `${ref.entity_type}:${ref.entity_id}`;
}

/**
 * Validate that an entity exists in its source DB and return its current status.
 * Returns { exists: true, status } on success, { exists: false } when missing,
 * { exists: false, reason } when the source DB is unavailable.
 */
function getEntityStatus(ref: EntityRef): { exists: boolean; status?: string; reason?: string } {
  try {
    if (ref.entity_type === 'todo') {
      if (!fs.existsSync(TODO_DB_PATH)) return { exists: false, reason: 'todo.db not found' };
      let db: Database.Database | null = null;
      try {
        db = openReadonlyDb(TODO_DB_PATH);
        const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(ref.entity_id) as
          | { status: string }
          | undefined;
        if (!row) return { exists: false };
        return { exists: true, status: row.status };
      } finally {
        db?.close();
      }
    } else if (ref.entity_type === 'persistent') {
      if (!fs.existsSync(PERSISTENT_TASKS_DB_PATH))
        return { exists: false, reason: 'persistent-tasks.db not found' };
      let db: Database.Database | null = null;
      try {
        db = openReadonlyDb(PERSISTENT_TASKS_DB_PATH);
        const row = db
          .prepare('SELECT status FROM persistent_tasks WHERE id = ?')
          .get(ref.entity_id) as { status: string } | undefined;
        if (!row) return { exists: false };
        return { exists: true, status: row.status };
      } finally {
        db?.close();
      }
    } else if (ref.entity_type === 'plan_task') {
      if (!fs.existsSync(PLANS_DB_PATH)) return { exists: false, reason: 'plans.db not found' };
      let db: Database.Database | null = null;
      try {
        db = openReadonlyDb(PLANS_DB_PATH);
        const row = db.prepare('SELECT status FROM plan_tasks WHERE id = ?').get(ref.entity_id) as
          | { status: string }
          | undefined;
        if (!row) return { exists: false };
        return { exists: true, status: row.status };
      } finally {
        db?.close();
      }
    } else if (ref.entity_type === 'plan') {
      if (!fs.existsSync(PLANS_DB_PATH)) return { exists: false, reason: 'plans.db not found' };
      let db: Database.Database | null = null;
      try {
        db = openReadonlyDb(PLANS_DB_PATH);
        const row = db.prepare('SELECT status FROM plans WHERE id = ?').get(ref.entity_id) as
          | { status: string }
          | undefined;
        if (!row) return { exists: false };
        return { exists: true, status: row.status };
      } finally {
        db?.close();
      }
    }
    return { exists: false, reason: `unknown entity_type ${ref.entity_type}` };
  } catch (err) {
    return { exists: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Returns true if a status counts as a "satisfying terminal state" for a dep —
 * blocker entity in this state means the dep can be inserted as 'satisfied'
 * and no pause action is needed on the blocked entity.
 */
function isSatisfyingTerminalStatus(entity_type: EntityType, status: string): boolean {
  if (entity_type === 'todo') return status === 'completed';
  if (entity_type === 'persistent') return status === 'completed';
  if (entity_type === 'plan_task') return status === 'completed' || status === 'skipped';
  if (entity_type === 'plan') return status === 'signed_off' || status === 'completed';
  return false;
}

/**
 * If a blocked entity is currently "running" (todo in_progress, persistent active,
 * plan_task in_progress/ready), pause it so the dep takes effect immediately.
 *
 * Returns the pause action recorded on the dep row, or null if no action was needed.
 *
 * Implementation details:
 *  - todo: kill the running session via session-queue.db (look up by metadata.taskId),
 *    mark queue item cancelled, reset todo task to 'pending'. Records 'killed_session'.
 *  - persistent: write status='paused' to persistent-tasks.db with metadata
 *    {pause_reason: 'cross_dep', do_not_auto_resume: true}. Records 'paused_persistent'.
 *  - plan_task: set status='paused' on plan_tasks row. Records 'paused_plan_task'.
 *
 * NOTE: the session-queue.js gate and the persistent_stale_pause_resume guard
 * are extended in followup PRs to recognize these pause actions. This function
 * does the minimum DB-level state change here. Cross-DB writes happen
 * in-process (matching existing cross-DB write patterns in this codebase).
 */
function pauseBlockedEntityIfRunning(ref: EntityRef): string | null {
  const status = getEntityStatus(ref);
  if (!status.exists || !status.status) return null;

  if (ref.entity_type === 'todo') {
    if (status.status !== 'in_progress') return null;

    // Look up linked session by metadata.taskId in session-queue.db (read-only first).
    let pid: number | null = null;
    let queueId: string | null = null;
    if (fs.existsSync(SESSION_QUEUE_DB_PATH)) {
      let queueDb: Database.Database | null = null;
      try {
        queueDb = openReadonlyDb(SESSION_QUEUE_DB_PATH);
        const rows = queueDb
          .prepare(
            "SELECT id, pid, metadata FROM queue_items WHERE status IN ('running', 'spawning', 'suspended')"
          )
          .all() as Array<{ id: string; pid: number | null; metadata: string | null }>;
        for (const row of rows) {
          const taskId = extractTaskIdFromMetadata(row.metadata);
          if (taskId === ref.entity_id) {
            pid = row.pid;
            queueId = row.id;
            break;
          }
        }
      } finally {
        queueDb?.close();
      }
    }

    // SIGTERM the running session (best-effort; not fatal if already dead).
    if (pid && pid > 0) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Already dead or not permitted — proceed.
      }
    }

    // Mark queue item cancelled with dep_pause reason (writable DB).
    if (queueId && fs.existsSync(SESSION_QUEUE_DB_PATH)) {
      let queueWriteDb: Database.Database | null = null;
      try {
        queueWriteDb = new Database(SESSION_QUEUE_DB_PATH);
        queueWriteDb.pragma('journal_mode = WAL');
        queueWriteDb.pragma('busy_timeout = 5000');
        queueWriteDb
          .prepare(
            "UPDATE queue_items SET status = 'cancelled', error = 'dep_pause', completed_at = ? WHERE id = ? AND status IN ('running', 'spawning', 'suspended')"
          )
          .run(now(), queueId);
      } catch {
        // Non-fatal — pause was best-effort.
      } finally {
        queueWriteDb?.close();
      }
    }

    // Reset todo task to pending so it re-spawns when dep is satisfied.
    if (fs.existsSync(TODO_DB_PATH)) {
      let todoWriteDb: Database.Database | null = null;
      try {
        todoWriteDb = new Database(TODO_DB_PATH);
        todoWriteDb.pragma('journal_mode = WAL');
        todoWriteDb.pragma('busy_timeout = 5000');
        todoWriteDb
          .prepare(
            "UPDATE tasks SET status = 'pending' WHERE id = ? AND status = 'in_progress'"
          )
          .run(ref.entity_id);
      } catch {
        // Non-fatal.
      } finally {
        todoWriteDb?.close();
      }
    }

    return 'killed_session';
  }

  if (ref.entity_type === 'persistent') {
    if (status.status !== 'active') return null;
    if (!fs.existsSync(PERSISTENT_TASKS_DB_PATH)) return null;

    let ptDb: Database.Database | null = null;
    try {
      ptDb = new Database(PERSISTENT_TASKS_DB_PATH);
      ptDb.pragma('journal_mode = WAL');
      ptDb.pragma('busy_timeout = 5000');

      // Read existing metadata, merge in pause_reason + do_not_auto_resume.
      const row = ptDb
        .prepare('SELECT metadata FROM persistent_tasks WHERE id = ?')
        .get(ref.entity_id) as { metadata: string | null } | undefined;
      let metaObj: Record<string, unknown> = {};
      if (row?.metadata) {
        try {
          metaObj = JSON.parse(row.metadata) as Record<string, unknown>;
        } catch {
          metaObj = {};
        }
      }
      metaObj['pause_reason'] = 'cross_dep';
      metaObj['do_not_auto_resume'] = true;

      ptDb
        .prepare(
          "UPDATE persistent_tasks SET status = 'paused', metadata = ? WHERE id = ? AND status = 'active'"
        )
        .run(JSON.stringify(metaObj), ref.entity_id);
    } catch {
      // Non-fatal.
    } finally {
      ptDb?.close();
    }

    return 'paused_persistent';
  }

  if (ref.entity_type === 'plan_task') {
    if (status.status !== 'in_progress' && status.status !== 'ready') return null;
    if (!fs.existsSync(PLANS_DB_PATH)) return null;

    let plansDb: Database.Database | null = null;
    try {
      plansDb = new Database(PLANS_DB_PATH);
      plansDb.pragma('journal_mode = WAL');
      plansDb.pragma('busy_timeout = 5000');
      plansDb
        .prepare(
          "UPDATE plan_tasks SET status = 'paused' WHERE id = ? AND status IN ('in_progress', 'ready')"
        )
        .run(ref.entity_id);
    } catch {
      // Non-fatal.
    } finally {
      plansDb?.close();
    }

    return 'paused_plan_task';
  }

  return null;
}

/**
 * Cycle detection via DFS over (entity_type, entity_id) compound node identity.
 * Returns true if adding (blocker -> blocked) would create a cycle.
 *
 * Starting from `blocked`, we follow existing blocker edges. If we reach
 * `blocker` during traversal, adding the new edge would close a cycle.
 */
function wouldCreateCycle(db: Database.Database, blocker: EntityRef, blocked: EntityRef): boolean {
  const visited = new Set<string>();
  const stack: EntityRef[] = [blocked];
  const blockerKey = entityKey(blocker);

  while (stack.length > 0) {
    const current = stack.pop()!;
    const currentKey = entityKey(current);
    if (currentKey === blockerKey) return true;
    if (visited.has(currentKey)) continue;
    visited.add(currentKey);

    // Follow edges where `current` is the blocked entity — what does current depend on?
    const edges = db
      .prepare(
        "SELECT blocker_task_id, blocker_entity_type FROM queue_dependencies WHERE blocked_entity_type = ? AND blocked_task_id = ? AND status = 'active'"
      )
      .all(current.entity_type, current.entity_id) as Array<{
      blocker_task_id: string;
      blocker_entity_type: string;
    }>;

    for (const edge of edges) {
      stack.push({
        entity_type: edge.blocker_entity_type as EntityType,
        entity_id: edge.blocker_task_id,
      });
    }
  }
  return false;
}

/**
 * Check if all active blockers for taskId have been completed (in todo.db).
 */
function areDependenciesMet(db: Database.Database, taskId: string, projectDir: string): boolean {
  // Legacy gate: only considers todo→todo deps for now. Cross-entity gates ship
  // in follow-up PRs (session-queue.js, activate_persistent_task, plan-orchestrator).
  const blockers = db
    .prepare(
      "SELECT blocker_task_id FROM queue_dependencies WHERE blocked_entity_type = 'todo' AND blocked_task_id = ? AND blocker_entity_type = 'todo' AND status = 'active'"
    )
    .all(taskId) as Array<{ blocker_task_id: string }>;

  if (blockers.length === 0) return true;

  const todoDbPath = path.join(projectDir, '.claude', 'todo.db');
  if (!fs.existsSync(todoDbPath)) {
    // Cannot determine — assume not met (fail-safe)
    return false;
  }

  let todoDb: Database.Database | null = null;
  try {
    todoDb = openReadonlyDb(todoDbPath);
    for (const { blocker_task_id } of blockers) {
      const task = todoDb
        .prepare('SELECT status FROM tasks WHERE id = ?')
        .get(blocker_task_id) as { status: string } | undefined;
      if (!task || task.status !== 'completed') {
        return false;
      }
    }
    return true;
  } finally {
    todoDb?.close();
  }
}

/**
 * Scan all active dependencies and mark them satisfied if their blocker
 * task has been completed in todo.db. Returns count of newly satisfied deps.
 */
function satisfyCompletedDeps(db: Database.Database, projectDir: string): number {
  // Legacy auto-satisfier: only considers deps where the blocker is a todo task.
  // Cross-entity satisfiers (persistent / plan_task completion) ship via the
  // shared `.claude/hooks/lib/cross-dep-satisfier.js` in follow-up PRs.
  const activeDeps = db
    .prepare(
      "SELECT id, blocker_task_id FROM queue_dependencies WHERE status = 'active' AND blocker_entity_type = 'todo'"
    )
    .all() as Array<{ id: string; blocker_task_id: string }>;

  if (activeDeps.length === 0) return 0;

  const todoDbPath = path.join(projectDir, '.claude', 'todo.db');
  if (!fs.existsSync(todoDbPath)) return 0;

  let todoDb: Database.Database | null = null;
  let satisfied = 0;
  try {
    todoDb = openReadonlyDb(todoDbPath);
    const ts = now();

    for (const dep of activeDeps) {
      const task = todoDb
        .prepare('SELECT status FROM tasks WHERE id = ?')
        .get(dep.blocker_task_id) as { status: string } | undefined;

      if (task?.status === 'completed') {
        db.prepare(
          "UPDATE queue_dependencies SET status = 'satisfied', satisfied_at = ? WHERE id = ?"
        ).run(ts, dep.id);

        db.prepare(
          'INSERT INTO workstream_changes (id, change_type, queue_id, task_id, details, reasoning, agent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(
          newChangeId(),
          'dependency_satisfied',
          null,
          dep.blocker_task_id,
          JSON.stringify({ dependency_id: dep.id }),
          `Blocker task ${dep.blocker_task_id} completed`,
          null,
          ts
        );

        satisfied++;
      }
    }
  } finally {
    todoDb?.close();
  }

  return satisfied;
}

/**
 * Exported helper used by session-queue.js drainQueue() to gate spawning.
 * Returns true if it is safe to spawn a task (all active blockers are satisfied).
 */
export function checkDependenciesMet(taskId: string, projectDir: string): boolean {
  try {
    const db = ensureDb();
    satisfyCompletedDeps(db, projectDir);
    return areDependenciesMet(db, taskId, projectDir);
  } catch (err) {
    // G001: Fail loudly — surface the error rather than silently allowing
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[workstream] checkDependenciesMet failed for task ${taskId}: ${message}`);
  }
}

// ============================================================================
// Read-only helpers for session-queue.db and todo.db
// ============================================================================

interface QueueRow {
  id: string;
  status: string;
  priority: string;
  title: string;
  agent_type: string;
  metadata: string | null;
  enqueued_at: string;
  spawned_at: string | null;
}

function readQueueItems(statuses: string[]): QueueRow[] {
  if (!fs.existsSync(SESSION_QUEUE_DB_PATH)) return [];

  let queueDb: Database.Database | null = null;
  try {
    queueDb = openReadonlyDb(SESSION_QUEUE_DB_PATH);
    const placeholders = statuses.map(() => '?').join(', ');
    return queueDb
      .prepare(
        `SELECT id, status, priority, title, agent_type, metadata, enqueued_at, spawned_at FROM queue_items WHERE status IN (${placeholders}) ORDER BY priority DESC, enqueued_at ASC`
      )
      .all(...statuses) as QueueRow[];
  } finally {
    queueDb?.close();
  }
}

function getTaskTitles(taskIds: string[]): Map<string, string> {
  const result = new Map<string, string>();
  if (taskIds.length === 0 || !fs.existsSync(TODO_DB_PATH)) return result;

  let todoDb: Database.Database | null = null;
  try {
    todoDb = openReadonlyDb(TODO_DB_PATH);
    const placeholders = taskIds.map(() => '?').join(', ');
    const rows = todoDb
      .prepare(`SELECT id, title FROM tasks WHERE id IN (${placeholders})`)
      .all(...taskIds) as Array<{ id: string; title: string }>;
    for (const row of rows) {
      result.set(row.id, row.title);
    }
  } catch {
    // Non-fatal — return what we have
  } finally {
    todoDb?.close();
  }
  return result;
}

function extractTaskIdFromMetadata(metadata: string | null): string | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    if (typeof parsed['taskId'] === 'string') return parsed['taskId'];
    return null;
  } catch {
    return null;
  }
}

// ============================================================================
// Tool: add_dependency
// ============================================================================

/**
 * Normalize the AddDependency union into entity-aware EntityRefs. Legacy
 * {blocked_task_id, blocker_task_id, reasoning} is treated as todo→todo.
 */
function normalizeAddDependencyArgs(args: AddDependencyArgs): {
  blocker: EntityRef;
  blocked: EntityRef;
  reasoning: string;
} {
  if (args.blocker !== undefined && args.blocked !== undefined) {
    return {
      blocker: { entity_type: args.blocker.entity_type, entity_id: args.blocker.entity_id },
      blocked: { entity_type: args.blocked.entity_type as EntityType, entity_id: args.blocked.entity_id },
      reasoning: args.reasoning,
    };
  }
  // Legacy todo→todo (refine guarantees both legacy fields are present here)
  return {
    blocker: { entity_type: 'todo', entity_id: args.blocker_task_id! },
    blocked: { entity_type: 'todo', entity_id: args.blocked_task_id! },
    reasoning: args.reasoning,
  };
}

async function handleAddDependency(
  args: AddDependencyArgs
): Promise<AddDependencyResult | ErrorResult> {
  const { blocker, blocked, reasoning } = normalizeAddDependencyArgs(args);

  if (entityKey(blocker) === entityKey(blocked)) {
    return { error: 'blocker and blocked must reference different entities' };
  }

  const db = ensureDb();

  // 1. Validate both entities exist in their source DBs.
  const blockerStatus = getEntityStatus(blocker);
  if (!blockerStatus.exists) {
    return {
      error: `Blocker ${entityKey(blocker)} not found${blockerStatus.reason ? ` (${blockerStatus.reason})` : ''}`,
    };
  }
  const blockedStatus = getEntityStatus(blocked);
  if (!blockedStatus.exists) {
    return {
      error: `Blocked entity ${entityKey(blocked)} not found${blockedStatus.reason ? ` (${blockedStatus.reason})` : ''}`,
    };
  }

  // 2. Auto-satisfy already-completed legacy todo deps (preserves existing behavior).
  satisfyCompletedDeps(db, PROJECT_DIR);

  // 3. Cycle detection (entity-aware).
  if (wouldCreateCycle(db, blocker, blocked)) {
    return {
      error: `Adding this dependency would create a cycle: ${entityKey(blocked)} -> ${entityKey(blocker)} already has a reverse path`,
    };
  }

  // 4. Dedup — any existing active dep between this exact pair.
  const existing = db
    .prepare(
      "SELECT id FROM queue_dependencies WHERE blocked_entity_type = ? AND blocked_task_id = ? AND blocker_entity_type = ? AND blocker_task_id = ? AND status = 'active'"
    )
    .get(blocked.entity_type, blocked.entity_id, blocker.entity_type, blocker.entity_id) as
    | { id: string }
    | undefined;

  if (existing) {
    return {
      dependency_id: existing.id,
      blocked_task_id: blocked.entity_id,
      blocked_entity_type: blocked.entity_type,
      blocker_task_id: blocker.entity_id,
      blocker_entity_type: blocker.entity_type,
      status: 'already_exists',
      pause_action: null,
      message: `Active dependency ${existing.id} already exists between these entities`,
    };
  }

  // 5. Look up queue IDs from session-queue.db by matching metadata.taskId
  //    (only meaningful for todo entities; persistent/plan_task entities don't
  //    map 1:1 to queue items the same way, but we still record what we find).
  let blockedQueueId: string | null = null;
  let blockerQueueId: string | null = null;

  if (fs.existsSync(SESSION_QUEUE_DB_PATH)) {
    let queueDb: Database.Database | null = null;
    try {
      queueDb = openReadonlyDb(SESSION_QUEUE_DB_PATH);
      const queueRows = queueDb
        .prepare(
          "SELECT id, metadata FROM queue_items WHERE status IN ('queued', 'spawning', 'running', 'suspended')"
        )
        .all() as Array<{ id: string; metadata: string | null }>;

      for (const row of queueRows) {
        const taskId = extractTaskIdFromMetadata(row.metadata);
        if (taskId === blocked.entity_id && blocked.entity_type === 'todo') blockedQueueId = row.id;
        if (taskId === blocker.entity_id && blocker.entity_type === 'todo') blockerQueueId = row.id;
      }
    } finally {
      queueDb?.close();
    }
  }

  const depId = newDepId();
  const ts = now();

  // 6. Already-completed short-circuit — insert as 'satisfied' immediately,
  //    skip pause action on the blocked entity.
  let depStatus: 'active' | 'satisfied' = 'active';
  let pauseAction: string | null = null;

  if (blockerStatus.status && isSatisfyingTerminalStatus(blocker.entity_type, blockerStatus.status)) {
    depStatus = 'satisfied';
  } else {
    // 7. Pause-if-running on the blocked entity.
    pauseAction = pauseBlockedEntityIfRunning(blocked);
  }

  db.prepare(
    'INSERT INTO queue_dependencies (id, blocked_queue_id, blocked_task_id, blocked_entity_type, blocker_queue_id, blocker_task_id, blocker_entity_type, status, created_by, reasoning, pause_action, created_at, satisfied_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    depId,
    blockedQueueId,
    blocked.entity_id,
    blocked.entity_type,
    blockerQueueId,
    blocker.entity_id,
    blocker.entity_type,
    depStatus,
    'workstream-manager',
    reasoning,
    pauseAction,
    ts,
    depStatus === 'satisfied' ? ts : null
  );

  db.prepare(
    'INSERT INTO workstream_changes (id, change_type, queue_id, task_id, details, reasoning, agent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    newChangeId(),
    'dependency_added',
    blockedQueueId,
    blocked.entity_id,
    JSON.stringify({
      dependency_id: depId,
      blocker: { entity_type: blocker.entity_type, entity_id: blocker.entity_id },
      blocked: { entity_type: blocked.entity_type, entity_id: blocked.entity_id },
      dep_status: depStatus,
      pause_action: pauseAction,
    }),
    reasoning,
    null,
    ts
  );

  const message =
    depStatus === 'satisfied'
      ? `Dependency ${depId} inserted as already-satisfied (blocker ${entityKey(blocker)} is in a terminal state). No pause action taken.`
      : pauseAction
        ? `Dependency ${depId} created. Blocked entity ${entityKey(blocked)} was running and was paused (${pauseAction}). It will resume when ${entityKey(blocker)} completes.`
        : `Dependency ${depId} created. ${entityKey(blocked)} is now blocked until ${entityKey(blocker)} completes.`;

  return {
    dependency_id: depId,
    blocked_task_id: blocked.entity_id,
    blocked_entity_type: blocked.entity_type,
    blocker_task_id: blocker.entity_id,
    blocker_entity_type: blocker.entity_type,
    status: depStatus === 'satisfied' ? 'satisfied' : 'created',
    pause_action: pauseAction,
    message,
  };
}

// ============================================================================
// Tool: remove_dependency
// ============================================================================

async function handleRemoveDependency(
  args: RemoveDependencyArgs
): Promise<RemoveDependencyResult | ErrorResult> {
  const { dependency_id, reasoning } = args;
  const db = ensureDb();

  const dep = db
    .prepare('SELECT id, status, blocked_task_id, blocked_queue_id FROM queue_dependencies WHERE id = ?')
    .get(dependency_id) as QueueDependencyRecord | undefined;

  if (!dep) {
    return { error: `Dependency ${dependency_id} not found` };
  }

  if (dep.status === 'removed') {
    return { error: `Dependency ${dependency_id} is already removed` };
  }

  const ts = now();
  db.prepare("UPDATE queue_dependencies SET status = 'removed' WHERE id = ?").run(dependency_id);

  db.prepare(
    'INSERT INTO workstream_changes (id, change_type, queue_id, task_id, details, reasoning, agent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    newChangeId(),
    'dependency_removed',
    dep.blocked_queue_id,
    dep.blocked_task_id,
    JSON.stringify({ dependency_id }),
    reasoning,
    null,
    ts
  );

  return {
    dependency_id,
    status: 'removed',
    message: `Dependency ${dependency_id} has been removed.`,
  };
}

// ============================================================================
// Tool: list_dependencies
// ============================================================================

async function handleListDependencies(
  args: ListDependenciesArgs
): Promise<ListDependenciesResult | ErrorResult> {
  const { task_id, status } = args;
  const db = ensureDb();

  // Auto-satisfy completed deps before listing
  satisfyCompletedDeps(db, PROJECT_DIR);

  let rows: QueueDependencyRecord[];

  if (task_id) {
    if (status === 'all') {
      rows = db
        .prepare(
          'SELECT * FROM queue_dependencies WHERE (blocked_task_id = ? OR blocker_task_id = ?) ORDER BY created_at DESC'
        )
        .all(task_id, task_id) as QueueDependencyRecord[];
    } else {
      rows = db
        .prepare(
          'SELECT * FROM queue_dependencies WHERE (blocked_task_id = ? OR blocker_task_id = ?) AND status = ? ORDER BY created_at DESC'
        )
        .all(task_id, task_id, status) as QueueDependencyRecord[];
    }
  } else {
    if (status === 'all') {
      rows = db
        .prepare('SELECT * FROM queue_dependencies ORDER BY created_at DESC')
        .all() as QueueDependencyRecord[];
    } else {
      rows = db
        .prepare('SELECT * FROM queue_dependencies WHERE status = ? ORDER BY created_at DESC')
        .all(status) as QueueDependencyRecord[];
    }
  }

  // Collect all task IDs to resolve titles
  const taskIds = new Set<string>();
  for (const row of rows) {
    taskIds.add(row.blocked_task_id);
    taskIds.add(row.blocker_task_id);
  }
  const titleMap = getTaskTitles(Array.from(taskIds));

  const dependencies: DependencyListItem[] = rows.map((row) => ({
    id: row.id,
    blocked_task_id: row.blocked_task_id,
    blocked_entity_type: row.blocked_entity_type,
    blocked_task_title:
      row.blocked_entity_type === 'todo' ? (titleMap.get(row.blocked_task_id) ?? null) : null,
    blocker_task_id: row.blocker_task_id,
    blocker_entity_type: row.blocker_entity_type,
    blocker_task_title:
      row.blocker_entity_type === 'todo' ? (titleMap.get(row.blocker_task_id) ?? null) : null,
    status: row.status,
    reasoning: row.reasoning,
    pause_action: row.pause_action,
    created_at: row.created_at,
    satisfied_at: row.satisfied_at,
  }));

  return { dependencies, total: dependencies.length };
}

// ============================================================================
// Tool: get_queue_context
// ============================================================================

async function handleGetQueueContext(
  _args: GetQueueContextArgs
): Promise<GetQueueContextResult | ErrorResult> {
  const db = ensureDb();

  // Satisfy completed deps first
  satisfyCompletedDeps(db, PROJECT_DIR);

  const runningRows = readQueueItems(['running', 'spawning']);
  const queuedRows = readQueueItems(['queued']);
  const suspendedRows = readQueueItems(['suspended']);

  // Load all active deps once
  const activeDeps = db
    .prepare("SELECT * FROM queue_dependencies WHERE status = 'active'")
    .all() as QueueDependencyRecord[];

  // Build a map: blocked_task_id -> list of blocker_task_ids
  const blockersMap = new Map<string, string[]>();
  for (const dep of activeDeps) {
    const existing = blockersMap.get(dep.blocked_task_id) ?? [];
    existing.push(dep.blocker_task_id);
    blockersMap.set(dep.blocked_task_id, existing);
  }

  // Collect task IDs for title resolution
  const allTaskIds = new Set<string>();
  for (const rows of [runningRows, queuedRows, suspendedRows]) {
    for (const row of rows) {
      const taskId = extractTaskIdFromMetadata(row.metadata);
      if (taskId) allTaskIds.add(taskId);
    }
  }
  for (const dep of activeDeps) {
    allTaskIds.add(dep.blocked_task_id);
    allTaskIds.add(dep.blocker_task_id);
  }
  const titleMap = getTaskTitles(Array.from(allTaskIds));

  function mapRows(rows: QueueRow[]): QueueItemContext[] {
    return rows.map((row) => {
      const taskId = extractTaskIdFromMetadata(row.metadata);
      const blockers = taskId ? (blockersMap.get(taskId) ?? []) : [];

      let dependencyStatus: 'BLOCKED' | 'CLEAR' | 'PENDING' | null = null;
      if (taskId) {
        if (blockers.length > 0) {
          dependencyStatus = 'BLOCKED';
        } else {
          dependencyStatus = 'CLEAR';
        }
      }

      return {
        id: row.id,
        status: row.status,
        priority: row.priority,
        title: row.title,
        agent_type: row.agent_type,
        task_id: taskId,
        task_title: taskId ? (titleMap.get(taskId) ?? null) : null,
        dependency_status: dependencyStatus,
        blockers,
        enqueued_at: row.enqueued_at,
        spawned_at: row.spawned_at,
      };
    });
  }

  const runningCtx = mapRows(runningRows);
  const queuedCtx = mapRows(queuedRows);
  const suspendedCtx = mapRows(suspendedRows);

  const blockedCount = queuedCtx.filter((i) => i.dependency_status === 'BLOCKED').length;
  const summary = [
    `Running: ${runningCtx.length}`,
    `Queued: ${queuedCtx.length} (${blockedCount} blocked by dependency)`,
    `Suspended: ${suspendedCtx.length}`,
    `Active dependencies: ${activeDeps.length}`,
  ].join(' | ');

  const depItems: DependencyListItem[] = activeDeps.map((dep) => ({
    id: dep.id,
    blocked_task_id: dep.blocked_task_id,
    blocked_entity_type: dep.blocked_entity_type,
    blocked_task_title:
      dep.blocked_entity_type === 'todo' ? (titleMap.get(dep.blocked_task_id) ?? null) : null,
    blocker_task_id: dep.blocker_task_id,
    blocker_entity_type: dep.blocker_entity_type,
    blocker_task_title:
      dep.blocker_entity_type === 'todo' ? (titleMap.get(dep.blocker_task_id) ?? null) : null,
    status: dep.status,
    reasoning: dep.reasoning,
    pause_action: dep.pause_action,
    created_at: dep.created_at,
    satisfied_at: dep.satisfied_at,
  }));

  return {
    running: runningCtx,
    queued: queuedCtx,
    suspended: suspendedCtx,
    active_dependencies: depItems,
    summary,
  };
}

// ============================================================================
// Tool: reorder_item
// ============================================================================

async function handleReorderItem(
  args: ReorderItemArgs
): Promise<ReorderItemResult | ErrorResult> {
  const { queue_id, new_priority, reasoning } = args;

  if (!fs.existsSync(SESSION_QUEUE_DB_PATH)) {
    return { error: 'session-queue.db not found. No items in queue.' };
  }

  // Read current priority for audit trail
  let oldPriority: string | null = null;
  let queueDb: Database.Database | null = null;
  try {
    queueDb = openReadonlyDb(SESSION_QUEUE_DB_PATH);
    const existing = queueDb
      .prepare("SELECT priority FROM queue_items WHERE id = ? AND status = 'queued'")
      .get(queue_id) as { priority: string } | undefined;

    if (!existing) {
      return {
        error: `Queue item ${queue_id} not found or is not in 'queued' status. Only queued items can be reordered.`,
      };
    }
    oldPriority = existing.priority;
  } finally {
    queueDb?.close();
  }

  // Write to session-queue.db — requires write access
  // session-queue.db is owned by the current user, so direct write is appropriate.
  let writeDb: Database.Database | null = null;
  try {
    writeDb = new Database(SESSION_QUEUE_DB_PATH);
    writeDb.pragma('journal_mode = WAL');
    writeDb.pragma('busy_timeout = 5000');
    const result = writeDb
      .prepare("UPDATE queue_items SET priority = ? WHERE id = ? AND status = 'queued'")
      .run(new_priority, queue_id);

    if (result.changes === 0) {
      return {
        error: `Failed to update queue item ${queue_id}. Item may have been dequeued.`,
      };
    }
  } finally {
    writeDb?.close();
  }

  const db = ensureDb();
  const ts = now();
  db.prepare(
    'INSERT INTO workstream_changes (id, change_type, queue_id, task_id, details, reasoning, agent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    newChangeId(),
    'priority_changed',
    queue_id,
    null,
    JSON.stringify({ queue_id, old_priority: oldPriority, new_priority }),
    reasoning,
    null,
    ts
  );

  return {
    queue_id,
    old_priority: oldPriority,
    new_priority,
    message: `Queue item ${queue_id} priority changed from '${oldPriority}' to '${new_priority}'.`,
  };
}

// ============================================================================
// Tool: record_assessment
// ============================================================================

async function handleRecordAssessment(
  args: RecordAssessmentArgs
): Promise<RecordAssessmentResult | ErrorResult> {
  const { task_id, queue_id, reasoning } = args;
  const db = ensureDb();

  const changeId = newChangeId();
  const ts = now();

  db.prepare(
    'INSERT INTO workstream_changes (id, change_type, queue_id, task_id, details, reasoning, agent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    changeId,
    'assessment_clear',
    queue_id ?? null,
    task_id,
    JSON.stringify({ task_id, queue_id: queue_id ?? null }),
    reasoning,
    null,
    ts
  );

  return {
    change_id: changeId,
    task_id,
    message: `Assessment recorded for task ${task_id}. No conflicts or blockers detected.`,
  };
}

// ============================================================================
// Tool: get_change_log
// ============================================================================

async function handleGetChangeLog(
  args: GetChangeLogArgs
): Promise<GetChangeLogResult | ErrorResult> {
  const { since, limit } = args;
  const db = ensureDb();

  let rows: Array<{
    id: string;
    change_type: string;
    queue_id: string | null;
    task_id: string | null;
    details: string;
    reasoning: string;
    agent_id: string | null;
    created_at: string;
  }>;

  if (since) {
    rows = db
      .prepare(
        'SELECT id, change_type, queue_id, task_id, details, reasoning, agent_id, created_at FROM workstream_changes WHERE created_at > ? ORDER BY created_at DESC LIMIT ?'
      )
      .all(since, limit) as typeof rows;
  } else {
    rows = db
      .prepare(
        'SELECT id, change_type, queue_id, task_id, details, reasoning, agent_id, created_at FROM workstream_changes ORDER BY created_at DESC LIMIT ?'
      )
      .all(limit) as typeof rows;
  }

  // Collect task IDs for title resolution
  const taskIds = new Set<string>();
  for (const row of rows) {
    if (row.task_id) taskIds.add(row.task_id);
  }
  const titleMap = getTaskTitles(Array.from(taskIds));

  const changes: ChangeLogItem[] = rows.map((row) => ({
    id: row.id,
    change_type: row.change_type,
    queue_id: row.queue_id,
    task_id: row.task_id,
    task_title: row.task_id ? (titleMap.get(row.task_id) ?? null) : null,
    details: row.details,
    reasoning: row.reasoning,
    agent_id: row.agent_id,
    created_at: row.created_at,
  }));

  return { changes, total: changes.length };
}

// ============================================================================
// Tool: register_supersession
// ============================================================================

async function handleRegisterSupersession(
  args: RegisterSupersessionArgs
): Promise<RegisterSupersessionResult | RegisterSupersessionExistsResult | ErrorResult> {
  const { original_task_id, superseding_task_id, reason } = args;

  if (original_task_id === superseding_task_id) {
    return { error: 'A task cannot supersede itself' };
  }

  const db = ensureDb();

  // Check for existing (dedup)
  const existing = db
    .prepare(
      'SELECT id, status FROM task_supersessions WHERE original_task_id = ? AND superseding_task_id = ?'
    )
    .get(original_task_id, superseding_task_id) as { id: string; status: string } | undefined;

  if (existing) {
    return {
      exists: true,
      id: existing.id,
      status: existing.status,
      message: 'Supersession already registered',
    };
  }

  const id = `sup-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const ts = now();

  db.prepare(
    'INSERT INTO task_supersessions (id, original_task_id, superseding_task_id, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, original_task_id, superseding_task_id, reason, 'active', ts);

  // Record change
  const changeId = newChangeId();
  db.prepare(
    'INSERT INTO workstream_changes (id, change_type, queue_id, task_id, details, reasoning, agent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    changeId,
    'supersession_registered',
    null,
    superseding_task_id,
    JSON.stringify({ supersession_id: id, original_task_id, superseding_task_id }),
    reason,
    process.env['CLAUDE_AGENT_ID'] || 'unknown',
    ts
  );

  // Check if superseding task is already completed — if so, resolve immediately
  let immediateResolution = false;
  try {
    if (fs.existsSync(TODO_DB_PATH)) {
      let todoDb: Database.Database | null = null;
      try {
        todoDb = openReadonlyDb(TODO_DB_PATH);
        const task = todoDb
          .prepare('SELECT status FROM tasks WHERE id = ?')
          .get(superseding_task_id) as { status: string } | undefined;
        if (task && task.status === 'completed') {
          // Superseding task already done — resolve immediately
          db.prepare(
            "UPDATE task_supersessions SET status = 'resolved', resolved_at = ? WHERE id = ?"
          ).run(ts, id);

          // Also satisfy any queue_dependencies on the original task
          const deps = db
            .prepare(
              "SELECT id FROM queue_dependencies WHERE blocker_task_id = ? AND status = 'active'"
            )
            .all(original_task_id) as Array<{ id: string }>;
          for (const dep of deps) {
            db.prepare(
              "UPDATE queue_dependencies SET status = 'satisfied', satisfied_at = ? WHERE id = ?"
            ).run(ts, dep.id);
          }

          immediateResolution = true;
        }
      } finally {
        todoDb?.close();
      }
    }
  } catch {
    // Non-fatal — supersession still registered
  }

  return {
    id,
    original_task_id,
    superseding_task_id,
    status: immediateResolution ? 'resolved' : 'active',
    immediate_resolution: immediateResolution,
    message: immediateResolution
      ? 'Supersession registered and immediately resolved (superseding task already completed)'
      : 'Supersession registered. Will auto-resolve when superseding task completes.',
  };
}

// ============================================================================
// Tool: list_supersessions
// ============================================================================

async function handleListSupersessions(
  args: ListSupersessionsArgs
): Promise<ListSupersessionsResult> {
  const db = ensureDb();
  let query = 'SELECT * FROM task_supersessions WHERE 1=1';
  const params: Array<string | number> = [];

  if (args.task_id) {
    query += ' AND (original_task_id = ? OR superseding_task_id = ?)';
    params.push(args.task_id, args.task_id);
  }
  if (args.status) {
    query += ' AND status = ?';
    params.push(args.status);
  }

  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(args.limit ?? 20);

  const rows = db.prepare(query).all(...params) as TaskSupersessionRecord[];
  return { count: rows.length, supersessions: rows };
}

// ============================================================================
// Tool: list_dependencies_for_entity
// ============================================================================

async function handleListDependenciesForEntity(
  args: ListDependenciesForEntityArgs
): Promise<ListDependenciesForEntityResult | ErrorResult> {
  const { entity_type, entity_id, direction, status } = args;
  const db = ensureDb();

  // Auto-satisfy completed legacy deps before reporting.
  satisfyCompletedDeps(db, PROJECT_DIR);

  const statusFilter = status === 'all' ? null : status;

  function fetchRows(matchSide: 'blocked' | 'blocker'): QueueDependencyRecord[] {
    const sideTypeCol = matchSide === 'blocked' ? 'blocked_entity_type' : 'blocker_entity_type';
    const sideIdCol = matchSide === 'blocked' ? 'blocked_task_id' : 'blocker_task_id';
    if (statusFilter) {
      return db
        .prepare(
          `SELECT * FROM queue_dependencies WHERE ${sideTypeCol} = ? AND ${sideIdCol} = ? AND status = ? ORDER BY created_at DESC`
        )
        .all(entity_type, entity_id, statusFilter) as QueueDependencyRecord[];
    }
    return db
      .prepare(
        `SELECT * FROM queue_dependencies WHERE ${sideTypeCol} = ? AND ${sideIdCol} = ? ORDER BY created_at DESC`
      )
      .all(entity_type, entity_id) as QueueDependencyRecord[];
  }

  // `blocking` = this entity is the BLOCKER of others (i.e., others wait on this).
  // `blocked_by` = this entity is the BLOCKED side (i.e., this waits on others).
  let blockingRows: QueueDependencyRecord[] = [];
  let blockedByRows: QueueDependencyRecord[] = [];

  if (direction === 'blocking' || direction === 'both') {
    blockingRows = fetchRows('blocker');
  }
  if (direction === 'blocked_by' || direction === 'both') {
    blockedByRows = fetchRows('blocked');
  }

  // Collect todo IDs for title resolution.
  const todoIds = new Set<string>();
  for (const row of [...blockingRows, ...blockedByRows]) {
    if (row.blocked_entity_type === 'todo') todoIds.add(row.blocked_task_id);
    if (row.blocker_entity_type === 'todo') todoIds.add(row.blocker_task_id);
  }
  const titleMap = getTaskTitles(Array.from(todoIds));

  function mapRow(row: QueueDependencyRecord): DependencyListItem {
    return {
      id: row.id,
      blocked_task_id: row.blocked_task_id,
      blocked_entity_type: row.blocked_entity_type,
      blocked_task_title:
        row.blocked_entity_type === 'todo' ? (titleMap.get(row.blocked_task_id) ?? null) : null,
      blocker_task_id: row.blocker_task_id,
      blocker_entity_type: row.blocker_entity_type,
      blocker_task_title:
        row.blocker_entity_type === 'todo' ? (titleMap.get(row.blocker_task_id) ?? null) : null,
      status: row.status,
      reasoning: row.reasoning,
      pause_action: row.pause_action,
      created_at: row.created_at,
      satisfied_at: row.satisfied_at,
    };
  }

  const blocking = blockingRows.map(mapRow);
  const blocked_by = blockedByRows.map(mapRow);

  return {
    entity_type,
    entity_id,
    direction,
    blocking,
    blocked_by,
    total: blocking.length + blocked_by.length,
  };
}

// ============================================================================
// Tool Registration
// ============================================================================

const tools: AnyToolHandler[] = [
  {
    name: 'add_dependency',
    description:
      "Block one entity until another completes. Supports cross-entity edges across todo / persistent / plan_task entities. New shape: { blocker: { entity_type, entity_id }, blocked: { entity_type, entity_id }, reasoning }. Legacy shape { blocked_task_id, blocker_task_id, reasoning } is still accepted (treated as todo→todo). Performs entity-aware cycle detection, validates both entities exist, inserts as 'satisfied' when the blocker is already in a terminal state, and pauses the blocked entity if it is currently running (todo: kill session + reset to pending; persistent: status='paused' with do_not_auto_resume; plan_task: status='paused').",
    schema: AddDependencyArgsSchema,
    handler: handleAddDependency,
  },
  {
    name: 'remove_dependency',
    description:
      'Remove (soft-delete) an existing dependency. The blocked task will no longer be held back by this dependency.',
    schema: RemoveDependencyArgsSchema,
    handler: handleRemoveDependency,
  },
  {
    name: 'list_dependencies',
    description:
      'List queue dependencies. Optionally filter by task_id (shows deps where task is blocked or blocker) and by status (active/satisfied/removed/all). Auto-satisfies legacy todo→todo dependencies whose blocker task is already completed. Returns blocked_entity_type, blocker_entity_type, and pause_action on each row.',
    schema: ListDependenciesArgsSchema,
    handler: handleListDependencies,
  },
  {
    name: 'list_dependencies_for_entity',
    description:
      "List dependencies that involve a specific entity (todo / persistent / plan_task). 'direction' selects 'blocking' (this entity blocks others), 'blocked_by' (this entity is blocked by others), or 'both' (default). Used by plan-managers and persistent-monitors to surface why a child is not spawning.",
    schema: ListDependenciesForEntityArgsSchema,
    handler: handleListDependenciesForEntity,
  },
  {
    name: 'get_queue_context',
    description:
      'Get full queue state with dependency overlay. Returns running, queued, and suspended items with [BLOCKED], [CLEAR], or [PENDING] dependency status. Also returns all active dependencies.',
    schema: GetQueueContextArgsSchema,
    handler: handleGetQueueContext,
  },
  {
    name: 'reorder_item',
    description:
      "Change the priority of a queued session-queue item. Only works on items in 'queued' status. Updates session-queue.db directly.",
    schema: ReorderItemArgsSchema,
    handler: handleReorderItem,
  },
  {
    name: 'record_assessment',
    description:
      'Record a clear assessment for a task — indicating it was reviewed and has no conflicts, no blockers needed. Creates an audit trail entry.',
    schema: RecordAssessmentArgsSchema,
    handler: handleRecordAssessment,
  },
  {
    name: 'get_change_log',
    description:
      'Get the workstream change history. Returns dependency additions/removals, priority changes, and assessments ordered by most recent first. Task titles are resolved from todo.db.',
    schema: GetChangeLogArgsSchema,
    handler: handleGetChangeLog,
  },
  {
    name: 'register_supersession',
    description:
      'Register that one task supersedes another. When the superseding task completes, agents waiting on the original task are automatically unblocked via dependency satisfaction.',
    schema: RegisterSupersessionArgsSchema,
    handler: handleRegisterSupersession,
  },
  {
    name: 'list_supersessions',
    description:
      'List task supersession relationships. Filter by task_id (shows both directions) or status.',
    schema: ListSupersessionsArgsSchema,
    handler: handleListSupersessions,
  },
];

// ============================================================================
// Server Startup
// ============================================================================

// MCP_SHARED_DAEMON guard — only start stdio server if NOT running in the daemon
if (!process.env['MCP_SHARED_DAEMON']) {
  const server = new McpServer({
    name: 'workstream',
    version: '1.0.0',
    tools,
  });

  server.start();
}
