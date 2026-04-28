#!/usr/bin/env node
/**
 * Persistent Task MCP Server
 *
 * Manages long-running, amendment-driven, monitored tasks. The CTO delegates
 * complex multi-step objectives; a persistent monitor session oversees sub-tasks
 * until completion, receiving amendments via session signals.
 *
 * Database: .claude/state/persistent-tasks.db (SQLite, WAL mode)
 * Tier: 2 (stateful, per-session stdio)
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (stdio MCP)
 *
 * @version 1.0.0
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { McpServer, type AnyToolHandler } from '../shared/server.js';
import {
  CreatePersistentTaskArgsSchema,
  ActivatePersistentTaskArgsSchema,
  GetPersistentTaskArgsSchema,
  ListPersistentTasksArgsSchema,
  AmendPersistentTaskArgsSchema,
  AcknowledgeAmendmentArgsSchema,
  PausePersistentTaskArgsSchema,
  ResumePersistentTaskArgsSchema,
  CancelPersistentTaskArgsSchema,
  CompletePersistentTaskArgsSchema,
  LinkSubtaskArgsSchema,
  GetPersistentTaskSummaryArgsSchema,
  type CreatePersistentTaskArgs,
  type ActivatePersistentTaskArgs,
  type GetPersistentTaskArgs,
  type ListPersistentTasksArgs,
  type AmendPersistentTaskArgs,
  type AcknowledgeAmendmentArgs,
  type PausePersistentTaskArgs,
  type ResumePersistentTaskArgs,
  type CancelPersistentTaskArgs,
  type CompletePersistentTaskArgs,
  type LinkSubtaskArgs,
  type GetPersistentTaskSummaryArgs,
  type PersistentTaskRecord,
  type AmendmentRecord,
  type ErrorResult,
} from './types.js';

// ============================================================================
// Configuration
// ============================================================================

const PROJECT_DIR = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
const TODO_DB_PATH = path.join(PROJECT_DIR, '.claude', 'todo.db');
const SIGNAL_MODULE_PATH = path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'session-signals.js');

// ============================================================================
// Database Schema
// ============================================================================

const SCHEMA = `
CREATE TABLE IF NOT EXISTS persistent_tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    original_input TEXT,
    outcome_criteria TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    parent_todo_task_id TEXT,
    monitor_agent_id TEXT,
    monitor_pid INTEGER,
    monitor_session_id TEXT,
    created_at TEXT NOT NULL,
    activated_at TEXT,
    completed_at TEXT,
    cancelled_at TEXT,
    last_heartbeat TEXT,
    cycle_count INTEGER DEFAULT 0,
    created_by TEXT DEFAULT 'cto',
    user_prompt_uuids TEXT,
    metadata TEXT,
    last_summary TEXT,
    CONSTRAINT valid_status CHECK (status IN ('draft','active','paused','completed','cancelled','failed'))
);

CREATE TABLE IF NOT EXISTS amendments (
    id TEXT PRIMARY KEY,
    persistent_task_id TEXT NOT NULL REFERENCES persistent_tasks(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    amendment_type TEXT DEFAULT 'addendum',
    created_at TEXT NOT NULL,
    created_by TEXT DEFAULT 'cto',
    delivered_at TEXT,
    acknowledged_at TEXT,
    CONSTRAINT valid_type CHECK (amendment_type IN ('addendum','correction','scope_change','priority_shift'))
);

CREATE INDEX IF NOT EXISTS idx_amendments_task ON amendments(persistent_task_id);
CREATE INDEX IF NOT EXISTS idx_amendments_undelivered ON amendments(persistent_task_id, delivered_at) WHERE delivered_at IS NULL;

CREATE TABLE IF NOT EXISTS sub_tasks (
    persistent_task_id TEXT NOT NULL REFERENCES persistent_tasks(id) ON DELETE CASCADE,
    todo_task_id TEXT NOT NULL,
    linked_at TEXT NOT NULL,
    linked_by TEXT DEFAULT 'monitor',
    PRIMARY KEY (persistent_task_id, todo_task_id)
);

CREATE INDEX IF NOT EXISTS idx_sub_tasks_task ON sub_tasks(persistent_task_id);

CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    persistent_task_id TEXT NOT NULL REFERENCES persistent_tasks(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    details TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_task ON events(persistent_task_id);
CREATE INDEX IF NOT EXISTS idx_events_time ON events(created_at);

CREATE TABLE IF NOT EXISTS blocker_diagnosis (
    id TEXT PRIMARY KEY,
    persistent_task_id TEXT NOT NULL,
    error_type TEXT NOT NULL,
    is_transient INTEGER NOT NULL DEFAULT 0,
    diagnosis_details TEXT NOT NULL,
    fix_attempts INTEGER NOT NULL DEFAULT 0,
    max_fix_attempts INTEGER NOT NULL DEFAULT 3,
    fix_task_ids TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    cooldown_until TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_blocker_diag_task ON blocker_diagnosis(persistent_task_id);
CREATE INDEX IF NOT EXISTS idx_blocker_diag_status ON blocker_diagnosis(status);
`;

// ============================================================================
// Database Management
// ============================================================================

let _db: Database.Database | null = null;

function initializeDatabase(): Database.Database {
  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);

  // Auto-migration: add last_summary column
  try { db.exec("SELECT last_summary FROM persistent_tasks LIMIT 0"); } catch { db.exec("ALTER TABLE persistent_tasks ADD COLUMN last_summary TEXT"); }

  return db;
}

function getDb(): Database.Database {
  if (!_db) {
    _db = initializeDatabase();
  }
  return _db;
}

function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

function now(): string {
  return new Date().toISOString();
}

function recordEvent(
  db: Database.Database,
  persistentTaskId: string,
  eventType: string,
  details?: Record<string, unknown> | null,
): void {
  db.prepare(
    'INSERT INTO events (id, persistent_task_id, event_type, details, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(randomUUID(), persistentTaskId, eventType, details ? JSON.stringify(details) : null, now());
}

/**
 * Dynamically import the session-signals module from the project's hooks directory.
 */
interface SignalsModule {
  sendSignal: (opts: Record<string, unknown>) => object;
}

async function getSignalsModule(): Promise<SignalsModule> {
  if (!fs.existsSync(SIGNAL_MODULE_PATH)) {
    throw new Error(`session-signals.js not found at ${SIGNAL_MODULE_PATH}`);
  }
  return import(`file://${SIGNAL_MODULE_PATH}`) as Promise<SignalsModule>;
}

/**
 * Send a directive-tier signal to a monitor agent with the amendment content.
 * Non-fatal: logs error but does not throw — the amendment is still recorded.
 */
async function sendAmendmentSignal(
  monitorAgentId: string,
  amendmentId: string,
  content: string,
  amendmentType: string,
): Promise<void> {
  try {
    const mod = await getSignalsModule();
    mod.sendSignal({
      fromAgentId: process.env.CLAUDE_AGENT_ID || 'cto-session',
      fromAgentType: process.env.CLAUDE_AGENT_ID ? 'agent' : 'cto',
      fromTaskTitle: 'persistent-task amendment',
      toAgentId: monitorAgentId,
      toAgentType: 'persistent-monitor',
      tier: 'directive',
      message: `[AMENDMENT:${amendmentId}] (${amendmentType}) ${content}`,
      projectDir: PROJECT_DIR,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Non-fatal: amendment is recorded; signal delivery will be retried via
    // the briefing hook on the monitor's next tool call.
    process.stderr.write(`[persistent-task] Warning: failed to send amendment signal to ${monitorAgentId}: ${message}\n`);
  }
}

// ============================================================================
// Tool Implementations
// ============================================================================

/**
 * Create a persistent task in draft status.
 * Also creates a parent task in todo.db (DEPUTY-CTO section, urgent priority).
 */
function createPersistentTask(args: CreatePersistentTaskArgs): object | ErrorResult {
  const db = getDb();
  const taskId = randomUUID();
  const ts = now();

  // Determine todo.db task title and description for the parent task
  const parentTitle = `[Persistent] ${args.title}`;
  const parentDescription = args.outcome_criteria
    ? `Outcome criteria: ${args.outcome_criteria}\n\nMonitor task for persistent task ${taskId}.`
    : `Monitor task for persistent task ${taskId}.`;

  let parentTodoTaskId: string | null = null;

  // Cross-DB write: create parent task in todo.db
  try {
    if (fs.existsSync(TODO_DB_PATH)) {
      const todoDb = new Database(TODO_DB_PATH);
      todoDb.pragma('journal_mode = WAL');
      todoDb.pragma('foreign_keys = ON');
      todoDb.pragma('busy_timeout = 5000');

      try {
        const parentId = randomUUID();
        // Auto-migrate: add persistent_task_id column if missing
        try {
          todoDb.prepare('SELECT persistent_task_id FROM tasks LIMIT 0').get();
        } catch {
          todoDb.exec('ALTER TABLE tasks ADD COLUMN persistent_task_id TEXT');
        }

        todoDb.prepare(
          `INSERT INTO tasks (id, section, title, description, status, priority, assigned_by, followup_enabled, created_at, persistent_task_id)
           VALUES (?, 'DEPUTY-CTO', ?, ?, 'pending', 'urgent', 'cto', 1, ?, ?)`
        ).run(parentId, parentTitle, parentDescription, ts, taskId);

        parentTodoTaskId = parentId;
      } finally {
        todoDb.close();
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Non-fatal: the persistent task is still created even if todo.db write fails.
    process.stderr.write(`[persistent-task] Warning: failed to create parent todo task: ${message}\n`);
  }

  // Build metadata JSON (stores demo_involved, strict_infra_guidance, plan linkage, and future extensible config)
  const metadataObj: Record<string, unknown> = {};
  if (args.demo_involved) metadataObj.demo_involved = true;
  if (args.strict_infra_guidance) metadataObj.strict_infra_guidance = true;
  if (args.plan_task_id) metadataObj.plan_task_id = args.plan_task_id;
  if (args.plan_id) metadataObj.plan_id = args.plan_id;
  if (args.is_plan_manager) metadataObj.is_plan_manager = true;
  const metadata = Object.keys(metadataObj).length > 0 ? JSON.stringify(metadataObj) : null;

  // Insert persistent task row
  db.prepare(
    `INSERT INTO persistent_tasks
       (id, title, prompt, original_input, outcome_criteria, status,
        parent_todo_task_id, created_at, created_by, user_prompt_uuids, metadata)
     VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, 'cto', ?, ?)`
  ).run(
    taskId,
    args.title,
    args.prompt,
    args.original_input ?? null,
    args.outcome_criteria ?? null,
    parentTodoTaskId,
    ts,
    args.user_prompt_uuids ? JSON.stringify(args.user_prompt_uuids) : null,
    metadata,
  );

  recordEvent(db, taskId, 'created', {
    title: args.title,
    parent_todo_task_id: parentTodoTaskId,
  });

  return {
    id: taskId,
    title: args.title,
    status: 'draft',
    parent_todo_task_id: parentTodoTaskId,
    created_at: ts,
  };
}

/**
 * Activate a persistent task (draft → active).
 * Sets activated_at. The monitor session spawning is handled by the slash
 * command / hook layer — this tool only manages the status transition.
 */
function activatePersistentTask(args: ActivatePersistentTaskArgs): object | ErrorResult {
  const db = getDb();
  const task = db.prepare('SELECT * FROM persistent_tasks WHERE id = ?').get(args.id) as PersistentTaskRecord | undefined;

  if (!task) {
    return { error: `Persistent task not found: ${args.id}` } as ErrorResult;
  }
  if (task.status !== 'draft') {
    return { error: `Cannot activate task in status '${task.status}' — task must be in 'draft' status` } as ErrorResult;
  }

  const ts = now();
  db.prepare(
    "UPDATE persistent_tasks SET status = 'active', activated_at = ? WHERE id = ?"
  ).run(ts, args.id);

  recordEvent(db, args.id, 'activated', { previous_status: 'draft' });

  return {
    id: args.id,
    title: task.title,
    status: 'active',
    activated_at: ts,
    parent_todo_task_id: task.parent_todo_task_id,
    message: 'Task activated. Monitor session auto-enqueued by PostToolUse hook — do NOT manually spawn.',
  };
}

/**
 * Get full persistent task details with optional amendments and sub-tasks.
 */
function getPersistentTask(args: GetPersistentTaskArgs): object | ErrorResult {
  const db = getDb();
  const task = db.prepare('SELECT * FROM persistent_tasks WHERE id = ?').get(args.id) as PersistentTaskRecord | undefined;

  if (!task) {
    return { error: `Persistent task not found: ${args.id}` } as ErrorResult;
  }

  const result: Record<string, unknown> = {
    id: task.id,
    title: task.title,
    prompt: task.prompt,
    original_input: task.original_input,
    outcome_criteria: task.outcome_criteria,
    status: task.status,
    parent_todo_task_id: task.parent_todo_task_id,
    monitor_agent_id: task.monitor_agent_id,
    monitor_pid: task.monitor_pid,
    monitor_session_id: task.monitor_session_id,
    created_at: task.created_at,
    activated_at: task.activated_at,
    completed_at: task.completed_at,
    cancelled_at: task.cancelled_at,
    last_heartbeat: task.last_heartbeat,
    cycle_count: task.cycle_count,
    created_by: task.created_by,
    user_prompt_uuids: task.user_prompt_uuids ? JSON.parse(task.user_prompt_uuids) : null,
    last_summary: task.last_summary,
  };

  // Parse metadata for strict_infra_guidance and demo_involved
  let strict_infra_guidance = false;
  let demo_involved = false;
  try {
    const meta = task.metadata ? JSON.parse(task.metadata) : {};
    strict_infra_guidance = meta.strict_infra_guidance === true;
    demo_involved = meta.demo_involved === true;
  } catch { /* non-fatal */ }
  result.strict_infra_guidance = strict_infra_guidance;
  result.demo_involved = demo_involved;

  if (args.include_amendments) {
    const amendments = db.prepare(
      'SELECT * FROM amendments WHERE persistent_task_id = ? ORDER BY created_at ASC'
    ).all(args.id) as AmendmentRecord[];
    result.amendments = amendments;
    result.amendment_count = amendments.length;
    result.pending_amendments = amendments.filter(a => !a.acknowledged_at).length;
  }

  if (args.include_subtasks) {
    const subtaskLinks = db.prepare(
      'SELECT todo_task_id, linked_at, linked_by FROM sub_tasks WHERE persistent_task_id = ? ORDER BY linked_at ASC'
    ).all(args.id) as Array<{ todo_task_id: string; linked_at: string; linked_by: string }>;

    const subtasks: Array<Record<string, unknown>> = [];

    if (subtaskLinks.length > 0 && fs.existsSync(TODO_DB_PATH)) {
      let todoDb: Database.Database | null = null;
      try {
        todoDb = new Database(TODO_DB_PATH, { readonly: true });
        const ids = subtaskLinks.map(s => s.todo_task_id);
        const placeholders = ids.map(() => '?').join(',');
        const todoTasks = todoDb.prepare(
          `SELECT id, title, status, section FROM tasks WHERE id IN (${placeholders})`
        ).all(...ids) as Array<{ id: string; title: string; status: string; section: string }>;
        const todoTaskMap = new Map(todoTasks.map(t => [t.id, t]));

        for (const link of subtaskLinks) {
          const todoTask = todoTaskMap.get(link.todo_task_id);
          subtasks.push({
            todo_task_id: link.todo_task_id,
            linked_at: link.linked_at,
            linked_by: link.linked_by,
            title: todoTask?.title ?? null,
            status: todoTask?.status ?? 'unknown',
            section: todoTask?.section ?? null,
          });
        }
      } finally {
        try { todoDb?.close(); } catch { /* ignore */ }
      }
    } else {
      for (const link of subtaskLinks) {
        subtasks.push({
          todo_task_id: link.todo_task_id,
          linked_at: link.linked_at,
          linked_by: link.linked_by,
          title: null,
          status: 'unknown',
          section: null,
        });
      }
    }

    result.sub_tasks = subtasks;
    result.sub_task_count = subtasks.length;
  }

  return result;
}

/**
 * List persistent tasks with optional status filter.
 * Includes amendment_count and sub-task counts per task.
 */
function listPersistentTasks(args: ListPersistentTasksArgs): object {
  const db = getDb();

  let query = 'SELECT * FROM persistent_tasks';
  const params: unknown[] = [];

  if (args.status) {
    query += ' WHERE status = ?';
    params.push(args.status);
  }

  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(args.limit);

  const tasks = db.prepare(query).all(...params) as PersistentTaskRecord[];

  // Enrich with counts
  const enriched = tasks.map(task => {
    const amendmentCount = (
      db.prepare('SELECT COUNT(*) as c FROM amendments WHERE persistent_task_id = ?').get(task.id) as { c: number }
    ).c;

    // Sub-task status counts from todo.db
    const subtaskLinks = db.prepare(
      'SELECT todo_task_id FROM sub_tasks WHERE persistent_task_id = ?'
    ).all(task.id) as Array<{ todo_task_id: string }>;

    let subtaskPending = 0;
    let subtaskInProgress = 0;
    let subtaskCompleted = 0;

    if (subtaskLinks.length > 0 && fs.existsSync(TODO_DB_PATH)) {
      let todoDb: Database.Database | null = null;
      try {
        todoDb = new Database(TODO_DB_PATH, { readonly: true });
        const ids = subtaskLinks.map(s => s.todo_task_id);
        const placeholders = ids.map(() => '?').join(',');
        const statuses = todoDb.prepare(
          `SELECT status FROM tasks WHERE id IN (${placeholders})`
        ).all(...ids) as Array<{ status: string }>;
        for (const row of statuses) {
          if (row.status === 'pending') subtaskPending++;
          else if (row.status === 'in_progress') subtaskInProgress++;
          else if (row.status === 'completed') subtaskCompleted++;
        }
      } catch {
        // Non-fatal: sub-task counts remain 0 if todo.db read fails
      } finally {
        try { todoDb?.close(); } catch { /* ignore */ }
      }
    }

    // Parse metadata for strict_infra_guidance and demo_involved
    let strict_infra_guidance = false;
    let demo_involved = false;
    try {
      const meta = task.metadata ? JSON.parse(task.metadata) : {};
      strict_infra_guidance = meta.strict_infra_guidance === true;
      demo_involved = meta.demo_involved === true;
    } catch { /* non-fatal */ }

    return {
      id: task.id,
      title: task.title,
      status: task.status,
      outcome_criteria: task.outcome_criteria,
      parent_todo_task_id: task.parent_todo_task_id,
      monitor_agent_id: task.monitor_agent_id,
      monitor_pid: task.monitor_pid,
      created_at: task.created_at,
      activated_at: task.activated_at,
      completed_at: task.completed_at,
      last_heartbeat: task.last_heartbeat,
      cycle_count: task.cycle_count,
      amendment_count: amendmentCount,
      strict_infra_guidance,
      demo_involved,
      sub_task_counts: {
        total: subtaskLinks.length,
        pending: subtaskPending,
        in_progress: subtaskInProgress,
        completed: subtaskCompleted,
      },
    };
  });

  return { tasks: enriched, total: enriched.length };
}

/**
 * Add an amendment to a persistent task.
 * Validates task is in draft or active status.
 * If active, sends a directive-tier signal to the monitor agent.
 */
async function amendPersistentTask(args: AmendPersistentTaskArgs): Promise<object | ErrorResult> {
  const db = getDb();
  const task = db.prepare('SELECT * FROM persistent_tasks WHERE id = ?').get(args.id) as PersistentTaskRecord | undefined;

  if (!task) {
    return { error: `Persistent task not found: ${args.id}` } as ErrorResult;
  }
  if (task.status !== 'draft' && task.status !== 'active' && task.status !== 'paused') {
    return { error: `Cannot amend task in status '${task.status}' — task must be in 'draft', 'active', or 'paused' status` } as ErrorResult;
  }

  const amendmentId = randomUUID();
  const ts = now();
  const amendmentType = args.amendment_type ?? 'addendum';

  db.prepare(
    `INSERT INTO amendments (id, persistent_task_id, content, amendment_type, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, 'cto')`
  ).run(amendmentId, args.id, args.content, amendmentType, ts);

  recordEvent(db, args.id, 'amended', {
    amendment_id: amendmentId,
    amendment_type: amendmentType,
  });

  // Auto-resume paused tasks when amended — the CTO adding an amendment
  // implies the monitor should wake up and process it.
  let autoResumed = false;
  if (task.status === 'paused') {
    db.prepare("UPDATE persistent_tasks SET status = 'active' WHERE id = ?").run(args.id);
    recordEvent(db, args.id, 'resumed', { reason: 'auto_resumed_by_amendment', amendment_id: amendmentId });
    autoResumed = true;
  }

  // If task is (or was just resumed to) active and has a monitor agent, send signal
  const effectiveStatus = autoResumed ? 'active' : task.status;
  if (effectiveStatus === 'active' && task.monitor_agent_id) {
    await sendAmendmentSignal(task.monitor_agent_id, amendmentId, args.content, amendmentType);

    // Mark as delivered
    db.prepare('UPDATE amendments SET delivered_at = ? WHERE id = ?').run(ts, amendmentId);
  }

  return {
    id: amendmentId,
    persistent_task_id: args.id,
    content: args.content,
    amendment_type: amendmentType,
    created_at: ts,
    created_by: 'cto',
    delivered_at: (effectiveStatus === 'active' && task.monitor_agent_id) ? ts : null,
    signal_sent: effectiveStatus === 'active' && !!task.monitor_agent_id,
    auto_resumed: autoResumed,
    ...(autoResumed ? { status: 'active' as const } : {}),
  };
}

/**
 * Mark an amendment as acknowledged by the monitor session.
 */
function acknowledgeAmendment(args: AcknowledgeAmendmentArgs): object | ErrorResult {
  const db = getDb();
  const amendment = db.prepare('SELECT * FROM amendments WHERE id = ?').get(args.id) as AmendmentRecord | undefined;

  if (!amendment) {
    return { error: `Amendment not found: ${args.id}` } as ErrorResult;
  }
  if (amendment.acknowledged_at) {
    return { error: `Amendment already acknowledged at ${amendment.acknowledged_at}` } as ErrorResult;
  }

  const ts = now();
  db.prepare('UPDATE amendments SET acknowledged_at = ? WHERE id = ?').run(ts, args.id);

  recordEvent(db, amendment.persistent_task_id, 'amendment_acknowledged', {
    amendment_id: args.id,
    amendment_type: amendment.amendment_type,
  });

  return {
    id: args.id,
    persistent_task_id: amendment.persistent_task_id,
    acknowledged_at: ts,
  };
}

/**
 * Pause an active persistent task.
 */
function pausePersistentTask(args: PausePersistentTaskArgs): object | ErrorResult {
  const db = getDb();
  const task = db.prepare('SELECT status, title FROM persistent_tasks WHERE id = ?').get(args.id) as Pick<PersistentTaskRecord, 'status' | 'title'> | undefined;

  if (!task) {
    return { error: `Persistent task not found: ${args.id}` } as ErrorResult;
  }
  if (task.status !== 'active') {
    return { error: `Cannot pause task in status '${task.status}' — task must be in 'active' status` } as ErrorResult;
  }

  db.prepare("UPDATE persistent_tasks SET status = 'paused' WHERE id = ?").run(args.id);

  recordEvent(db, args.id, 'paused', { reason: args.reason ?? null });

  return {
    id: args.id,
    title: task.title,
    status: 'paused',
    reason: args.reason ?? null,
  };
}

/**
 * Resume a paused persistent task.
 */
function resumePersistentTask(args: ResumePersistentTaskArgs): object | ErrorResult {
  const db = getDb();
  const task = db.prepare('SELECT status, title FROM persistent_tasks WHERE id = ?').get(args.id) as Pick<PersistentTaskRecord, 'status' | 'title'> | undefined;

  if (!task) {
    return { error: `Persistent task not found: ${args.id}` } as ErrorResult;
  }
  if (task.status !== 'paused') {
    return { error: `Cannot resume task in status '${task.status}' — task must be in 'paused' status` } as ErrorResult;
  }

  db.prepare("UPDATE persistent_tasks SET status = 'active' WHERE id = ?").run(args.id);

  recordEvent(db, args.id, 'resumed', {});

  return {
    id: args.id,
    title: task.title,
    status: 'active',
  };
}

/**
 * Cancel a persistent task.
 */
function cancelPersistentTask(args: CancelPersistentTaskArgs): object | ErrorResult {
  const db = getDb();
  const task = db.prepare('SELECT status, title FROM persistent_tasks WHERE id = ?').get(args.id) as Pick<PersistentTaskRecord, 'status' | 'title'> | undefined;

  if (!task) {
    return { error: `Persistent task not found: ${args.id}` } as ErrorResult;
  }
  if (!['draft', 'active', 'paused'].includes(task.status)) {
    return { error: `Cannot cancel task in status '${task.status}' — task must be in 'draft', 'active', or 'paused' status` } as ErrorResult;
  }

  const ts = now();
  db.prepare(
    "UPDATE persistent_tasks SET status = 'cancelled', cancelled_at = ? WHERE id = ?"
  ).run(ts, args.id);

  recordEvent(db, args.id, 'cancelled', { reason: args.reason ?? null });

  return {
    id: args.id,
    title: task.title,
    status: 'cancelled',
    cancelled_at: ts,
    reason: args.reason ?? null,
  };
}

/**
 * Complete a persistent task (active → completed).
 * Also updates the parent todo.db task to completed.
 */
function completePersistentTask(args: CompletePersistentTaskArgs): object | ErrorResult {
  const db = getDb();
  const task = db.prepare('SELECT * FROM persistent_tasks WHERE id = ?').get(args.id) as PersistentTaskRecord | undefined;

  if (!task) {
    return { error: `Persistent task not found: ${args.id}` } as ErrorResult;
  }
  if (task.status !== 'active') {
    return { error: `Cannot complete task in status '${task.status}' — task must be in 'active' status` } as ErrorResult;
  }

  const ts = now();
  db.prepare(
    "UPDATE persistent_tasks SET status = 'completed', completed_at = ? WHERE id = ?"
  ).run(ts, args.id);

  recordEvent(db, args.id, 'completed', { summary: args.summary ?? null });

  // Cross-DB write: complete the parent todo.db task
  if (task.parent_todo_task_id && fs.existsSync(TODO_DB_PATH)) {
    let todoDb: Database.Database | null = null;
    try {
      todoDb = new Database(TODO_DB_PATH);
      todoDb.pragma('journal_mode = WAL');
      todoDb.pragma('foreign_keys = ON');
      todoDb.pragma('busy_timeout = 5000');
      todoDb.prepare(
        "UPDATE tasks SET status = 'completed', completed_at = ? WHERE id = ? AND status != 'completed'"
      ).run(ts, task.parent_todo_task_id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[persistent-task] Warning: failed to complete parent todo task ${task.parent_todo_task_id}: ${message}\n`);
    } finally {
      try { todoDb?.close(); } catch { /* ignore */ }
    }
  }

  return {
    id: args.id,
    title: task.title,
    status: 'completed',
    completed_at: ts,
    summary: args.summary ?? null,
    parent_todo_task_id: task.parent_todo_task_id,
  };
}

/**
 * Link a todo.db task to a persistent task.
 * Also updates the persistent_task_id column on the todo.db task (backward-compat).
 */
function linkSubtask(args: LinkSubtaskArgs): object | ErrorResult {
  const db = getDb();
  const task = db.prepare('SELECT id, title FROM persistent_tasks WHERE id = ?').get(args.persistent_task_id) as Pick<PersistentTaskRecord, 'id' | 'title'> | undefined;

  if (!task) {
    return { error: `Persistent task not found: ${args.persistent_task_id}` } as ErrorResult;
  }

  // Check for duplicate link
  const existing = db.prepare(
    'SELECT 1 FROM sub_tasks WHERE persistent_task_id = ? AND todo_task_id = ?'
  ).get(args.persistent_task_id, args.todo_task_id);
  if (existing) {
    return { error: `Sub-task ${args.todo_task_id} is already linked to persistent task ${args.persistent_task_id}` } as ErrorResult;
  }

  const ts = now();
  db.prepare(
    'INSERT INTO sub_tasks (persistent_task_id, todo_task_id, linked_at, linked_by) VALUES (?, ?, ?, ?)'
  ).run(args.persistent_task_id, args.todo_task_id, ts, process.env.CLAUDE_AGENT_ID || 'monitor');

  recordEvent(db, args.persistent_task_id, 'subtask_linked', {
    todo_task_id: args.todo_task_id,
  });

  // Cross-DB write: update persistent_task_id on the todo task (backward-compat)
  if (fs.existsSync(TODO_DB_PATH)) {
    let todoDb: Database.Database | null = null;
    try {
      todoDb = new Database(TODO_DB_PATH);
      todoDb.pragma('journal_mode = WAL');
      todoDb.pragma('foreign_keys = ON');
      todoDb.pragma('busy_timeout = 5000');

      try {
        todoDb.prepare('SELECT persistent_task_id FROM tasks LIMIT 0').get();
      } catch {
        todoDb.exec('ALTER TABLE tasks ADD COLUMN persistent_task_id TEXT');
      }

      todoDb.prepare(
        'UPDATE tasks SET persistent_task_id = ? WHERE id = ?'
      ).run(args.persistent_task_id, args.todo_task_id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Non-fatal: sub-task is still linked; just couldn't back-fill the column
      process.stderr.write(`[persistent-task] Warning: failed to update persistent_task_id on todo task ${args.todo_task_id}: ${message}\n`);
    } finally {
      try { todoDb?.close(); } catch { /* ignore */ }
    }
  }

  return {
    persistent_task_id: args.persistent_task_id,
    todo_task_id: args.todo_task_id,
    linked_at: ts,
  };
}

/**
 * Return a compact summary of a persistent task — designed for hook injection.
 */
function getPersistentTaskSummary(args: GetPersistentTaskSummaryArgs): object | ErrorResult {
  const db = getDb();
  const task = db.prepare('SELECT * FROM persistent_tasks WHERE id = ?').get(args.id) as PersistentTaskRecord | undefined;

  if (!task) {
    return { error: `Persistent task not found: ${args.id}` } as ErrorResult;
  }

  const amendmentCount = (
    db.prepare('SELECT COUNT(*) as c FROM amendments WHERE persistent_task_id = ?').get(args.id) as { c: number }
  ).c;

  const pendingAmendmentCount = (
    db.prepare('SELECT COUNT(*) as c FROM amendments WHERE persistent_task_id = ? AND acknowledged_at IS NULL').get(args.id) as { c: number }
  ).c;

  const subtaskLinks = db.prepare(
    'SELECT todo_task_id FROM sub_tasks WHERE persistent_task_id = ?'
  ).all(args.id) as Array<{ todo_task_id: string }>;

  let subtaskPending = 0;
  let subtaskInProgress = 0;
  let subtaskCompleted = 0;

  if (subtaskLinks.length > 0 && fs.existsSync(TODO_DB_PATH)) {
    let todoDb: Database.Database | null = null;
    try {
      todoDb = new Database(TODO_DB_PATH, { readonly: true });
      const ids = subtaskLinks.map(s => s.todo_task_id);
      const placeholders = ids.map(() => '?').join(',');
      const statuses = todoDb.prepare(
        `SELECT status FROM tasks WHERE id IN (${placeholders})`
      ).all(...ids) as Array<{ status: string }>;
      for (const row of statuses) {
        if (row.status === 'pending') subtaskPending++;
        else if (row.status === 'in_progress') subtaskInProgress++;
        else if (row.status === 'completed') subtaskCompleted++;
      }
    } catch {
      // Non-fatal
    } finally {
      try { todoDb?.close(); } catch { /* ignore */ }
    }
  }

  return {
    id: task.id,
    title: task.title,
    status: task.status,
    outcome_criteria: task.outcome_criteria,
    amendment_count: amendmentCount,
    pending_amendments: pendingAmendmentCount,
    sub_task_counts: {
      total: subtaskLinks.length,
      pending: subtaskPending,
      in_progress: subtaskInProgress,
      completed: subtaskCompleted,
    },
    last_heartbeat: task.last_heartbeat,
    cycle_count: task.cycle_count,
    monitor_agent_id: task.monitor_agent_id,
    monitor_pid: task.monitor_pid,
    activated_at: task.activated_at,
    last_summary: task.last_summary,
  };
}

// ============================================================================
// Server Setup
// ============================================================================

const tools: AnyToolHandler[] = [
  {
    name: 'create_persistent_task',
    description: 'Create a persistent task in draft status. Also creates a parent task in todo.db (DEPUTY-CTO section, urgent). Returns task ID for use in activate_persistent_task.',
    schema: CreatePersistentTaskArgsSchema,
    handler: createPersistentTask,
  },
  {
    name: 'activate_persistent_task',
    description: 'Activate a persistent task (draft → active). Sets activated_at. A PostToolUse hook automatically enqueues the monitor session — do NOT manually spawn or create tasks for the monitor.',
    schema: ActivatePersistentTaskArgsSchema,
    handler: activatePersistentTask,
  },
  {
    name: 'get_persistent_task',
    description: 'Get full persistent task details including amendments (ordered ASC) and sub-tasks with current status from todo.db.',
    schema: GetPersistentTaskArgsSchema,
    handler: getPersistentTask,
  },
  {
    name: 'list_persistent_tasks',
    description: 'List persistent tasks with optional status filter. Includes amendment_count and sub-task counts (pending/in_progress/completed).',
    schema: ListPersistentTasksArgsSchema,
    handler: listPersistentTasks,
  },
  {
    name: 'amend_persistent_task',
    description: 'Add an amendment to a persistent task. If the task is active, sends a directive-tier signal to the monitor. If paused, auto-resumes and a PostToolUse hook enqueues the monitor — do NOT manually spawn.',
    schema: AmendPersistentTaskArgsSchema,
    handler: amendPersistentTask,
  },
  {
    name: 'acknowledge_amendment',
    description: 'Mark an amendment as acknowledged. Called by the monitor session after processing an amendment.',
    schema: AcknowledgeAmendmentArgsSchema,
    handler: acknowledgeAmendment,
  },
  {
    name: 'pause_persistent_task',
    description: 'Pause an active persistent task (active → paused). The monitor session should be signalled separately to wrap up.',
    schema: PausePersistentTaskArgsSchema,
    handler: pausePersistentTask,
  },
  {
    name: 'resume_persistent_task',
    description: 'Resume a paused persistent task (paused → active). A PostToolUse hook automatically enqueues a new monitor session — do NOT manually spawn or create tasks for the monitor.',
    schema: ResumePersistentTaskArgsSchema,
    handler: resumePersistentTask,
  },
  {
    name: 'cancel_persistent_task',
    description: 'Cancel a persistent task in draft, active, or paused status. Records reason in events.',
    schema: CancelPersistentTaskArgsSchema,
    handler: cancelPersistentTask,
  },
  {
    name: 'complete_persistent_task',
    description: 'Complete an active persistent task. Also completes the parent todo.db task. Called by the monitor session when outcome criteria are met.',
    schema: CompletePersistentTaskArgsSchema,
    handler: completePersistentTask,
  },
  {
    name: 'link_subtask',
    description: 'Link a todo.db task to this persistent task. Records in sub_tasks table and back-fills persistent_task_id on the todo task.',
    schema: LinkSubtaskArgsSchema,
    handler: linkSubtask,
  },
  {
    name: 'get_persistent_task_summary',
    description: 'Get a compact summary suitable for hook injection: id, title, status, outcome_criteria, amendment counts, sub-task counts, heartbeat, cycle_count.',
    schema: GetPersistentTaskSummaryArgsSchema,
    handler: getPersistentTaskSummary,
  },
];

const server = new McpServer({
  name: 'persistent-task',
  version: '1.0.0',
  tools,
});

// Handle cleanup on exit
process.on('SIGINT', () => {
  closeDb();
  process.exit(0);
});

process.on('SIGTERM', () => {
  closeDb();
  process.exit(0);
});

server.start();
