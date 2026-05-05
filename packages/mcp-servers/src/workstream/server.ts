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
  GetQueueContextArgsSchema,
  ReorderItemArgsSchema,
  RecordAssessmentArgsSchema,
  GetChangeLogArgsSchema,
  RegisterSupersessionArgsSchema,
  ListSupersessionsArgsSchema,
  type AddDependencyArgs,
  type RemoveDependencyArgs,
  type ListDependenciesArgs,
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
  type GetQueueContextResult,
  type ReorderItemResult,
  type RecordAssessmentResult,
  type GetChangeLogResult,
  type ChangeLogItem,
  type RegisterSupersessionResult,
  type RegisterSupersessionExistsResult,
  type ListSupersessionsResult,
  type TaskSupersessionRecord,
} from './types.js';

// ============================================================================
// Configuration
// ============================================================================

const PROJECT_DIR = path.resolve(process.env['CLAUDE_PROJECT_DIR'] || process.cwd());
const DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'workstream.db');
const SESSION_QUEUE_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'session-queue.db');
const TODO_DB_PATH = path.join(PROJECT_DIR, '.claude', 'todo.db');

// ============================================================================
// Database Schema
// ============================================================================

const SCHEMA = `
CREATE TABLE IF NOT EXISTS queue_dependencies (
  id TEXT PRIMARY KEY,
  blocked_queue_id TEXT,
  blocked_task_id TEXT NOT NULL,
  blocker_queue_id TEXT,
  blocker_task_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  created_at TEXT NOT NULL,
  satisfied_at TEXT,
  UNIQUE(blocked_task_id, blocker_task_id)
);
CREATE INDEX IF NOT EXISTS idx_dep_blocked ON queue_dependencies(blocked_task_id, status);
CREATE INDEX IF NOT EXISTS idx_dep_blocker ON queue_dependencies(blocker_task_id, status);

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

/**
 * Cycle detection via DFS.
 * Returns true if adding (blocker -> blocked) would create a cycle.
 *
 * Starting from `blockedId`, we follow existing blocker edges. If we reach
 * `blockerId` during traversal, adding the new edge would close a cycle.
 */
function wouldCreateCycle(db: Database.Database, blockerId: string, blockedId: string): boolean {
  const visited = new Set<string>();
  const stack = [blockedId];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === blockerId) return true;
    if (visited.has(current)) continue;
    visited.add(current);

    // Follow edges where `current` is the blocked task — i.e., what does current depend on?
    const edges = db
      .prepare(
        "SELECT blocker_task_id FROM queue_dependencies WHERE blocked_task_id = ? AND status = 'active'"
      )
      .all(current) as Array<{ blocker_task_id: string }>;

    for (const edge of edges) {
      stack.push(edge.blocker_task_id);
    }
  }
  return false;
}

/**
 * Check if all active blockers for taskId have been completed (in todo.db).
 */
function areDependenciesMet(db: Database.Database, taskId: string, projectDir: string): boolean {
  const blockers = db
    .prepare(
      "SELECT blocker_task_id FROM queue_dependencies WHERE blocked_task_id = ? AND status = 'active'"
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
  const activeDeps = db
    .prepare("SELECT id, blocker_task_id FROM queue_dependencies WHERE status = 'active'")
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

async function handleAddDependency(
  args: AddDependencyArgs
): Promise<AddDependencyResult | ErrorResult> {
  const { blocked_task_id, blocker_task_id, reasoning } = args;

  if (blocked_task_id === blocker_task_id) {
    return { error: 'blocked_task_id and blocker_task_id must be different' };
  }

  const db = ensureDb();

  // First, auto-satisfy any already-completed blockers
  satisfyCompletedDeps(db, PROJECT_DIR);

  // Check if blocker is already completed — no need for a dependency
  let todoDb: Database.Database | null = null;
  try {
    todoDb = openReadonlyDb(TODO_DB_PATH);
    const blockerTask = todoDb
      .prepare('SELECT status FROM tasks WHERE id = ?')
      .get(blocker_task_id) as { status: string } | undefined;

    if (blockerTask?.status === 'completed') {
      return {
        dependency_id: '',
        blocked_task_id,
        blocker_task_id,
        status: 'skipped',
        message: `Blocker task ${blocker_task_id} is already completed. No dependency needed.`,
      };
    }
  } finally {
    todoDb?.close();
  }

  // Cycle detection
  if (wouldCreateCycle(db, blocker_task_id, blocked_task_id)) {
    return {
      error: `Adding this dependency would create a cycle: ${blocked_task_id} -> ${blocker_task_id} already has a reverse path`,
    };
  }

  // Check for existing active dependency
  const existing = db
    .prepare(
      "SELECT id FROM queue_dependencies WHERE blocked_task_id = ? AND blocker_task_id = ? AND status = 'active'"
    )
    .get(blocked_task_id, blocker_task_id) as { id: string } | undefined;

  if (existing) {
    return {
      dependency_id: existing.id,
      blocked_task_id,
      blocker_task_id,
      status: 'already_exists',
      message: `Active dependency ${existing.id} already exists between these tasks`,
    };
  }

  // Look up queue IDs from session-queue.db by matching metadata.taskId
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
        if (taskId === blocked_task_id) blockedQueueId = row.id;
        if (taskId === blocker_task_id) blockerQueueId = row.id;
      }
    } finally {
      queueDb?.close();
    }
  }

  const depId = newDepId();
  const ts = now();

  db.prepare(
    'INSERT INTO queue_dependencies (id, blocked_queue_id, blocked_task_id, blocker_queue_id, blocker_task_id, status, created_by, reasoning, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(depId, blockedQueueId, blocked_task_id, blockerQueueId, blocker_task_id, 'active', 'workstream-manager', reasoning, ts);

  db.prepare(
    'INSERT INTO workstream_changes (id, change_type, queue_id, task_id, details, reasoning, agent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    newChangeId(),
    'dependency_added',
    blockedQueueId,
    blocked_task_id,
    JSON.stringify({ dependency_id: depId, blocker_task_id, blocked_task_id }),
    reasoning,
    null,
    ts
  );

  return {
    dependency_id: depId,
    blocked_task_id,
    blocker_task_id,
    status: 'created',
    message: `Dependency ${depId} created. Task ${blocked_task_id} is now blocked until ${blocker_task_id} completes.`,
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
    blocked_task_title: titleMap.get(row.blocked_task_id) ?? null,
    blocker_task_id: row.blocker_task_id,
    blocker_task_title: titleMap.get(row.blocker_task_id) ?? null,
    status: row.status,
    reasoning: row.reasoning,
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
    blocked_task_title: titleMap.get(dep.blocked_task_id) ?? null,
    blocker_task_id: dep.blocker_task_id,
    blocker_task_title: titleMap.get(dep.blocker_task_id) ?? null,
    status: dep.status,
    reasoning: dep.reasoning,
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
// Tool Registration
// ============================================================================

const tools: AnyToolHandler[] = [
  {
    name: 'add_dependency',
    description:
      'Block a task until another task completes. Prevents the blocked task from being spawned until the blocker finishes. Performs cycle detection and skips if blocker is already completed.',
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
      'List queue dependencies. Optionally filter by task_id (shows deps where task is blocked or blocker) and by status (active/satisfied/removed/all). Auto-satisfies dependencies whose blocker task is already completed.',
    schema: ListDependenciesArgsSchema,
    handler: handleListDependencies,
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
