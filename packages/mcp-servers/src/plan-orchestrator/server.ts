#!/usr/bin/env node
/**
 * Plan Orchestrator MCP Server
 *
 * Manages structured execution plans with phases, tasks, substeps,
 * dependencies, and cross-DB integration with todo.db.
 *
 * Database: .claude/state/plans.db (SQLite, WAL mode)
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
  CreatePlanArgsSchema,
  GetPlanArgsSchema,
  ListPlansArgsSchema,
  UpdatePlanStatusArgsSchema,
  AddPhaseArgsSchema,
  UpdatePhaseArgsSchema,
  AddPlanTaskArgsSchema,
  UpdateTaskProgressArgsSchema,
  LinkTaskArgsSchema,
  AddSubstepsArgsSchema,
  CompleteSubstepArgsSchema,
  AddDependencyArgsSchema,
  GetSpawnReadyTasksArgsSchema,
  PlanDashboardArgsSchema,
  PlanTimelineArgsSchema,
  PlanAuditArgsSchema,
  type CreatePlanArgs,
  type GetPlanArgs,
  type ListPlansArgs,
  type UpdatePlanStatusArgs,
  type AddPhaseArgs,
  type UpdatePhaseArgs,
  type AddPlanTaskArgs,
  type UpdateTaskProgressArgs,
  type LinkTaskArgs,
  type AddSubstepsArgs,
  type CompleteSubstepArgs,
  type AddDependencyArgs,
  type GetSpawnReadyTasksArgs,
  type PlanDashboardArgs,
  type PlanTimelineArgs,
  type PlanAuditArgs,
  type PlanRecord,
  type PhaseRecord,
  type PlanTaskRecord,
  type SubstepRecord,
  type StateChangeRecord,
  type ErrorResult,
} from './types.js';
import {
  progressBar,
  substepIndicator,
  formatStatus,
  formatTimeAgo,
  formatTokens,
  type TimelineEntry,
  formatTimeline,
} from './format.js';

// ============================================================================
// Configuration
// ============================================================================

const PROJECT_DIR = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'plans.db');
const TODO_DB_PATH = path.join(PROJECT_DIR, '.claude', 'todo.db');
const WORKLOG_DB_PATH = path.join(PROJECT_DIR, '.claude', 'worklog.db');

// ============================================================================
// Database Schema
// ============================================================================

const SCHEMA = `
CREATE TABLE IF NOT EXISTS plans (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    created_by TEXT,
    metadata TEXT,
    CONSTRAINT valid_plan_status CHECK (status IN ('draft','active','paused','completed','archived'))
);

CREATE TABLE IF NOT EXISTS phases (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    phase_order INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    metadata TEXT,
    CONSTRAINT valid_phase_status CHECK (status IN ('pending','in_progress','completed','skipped'))
);

CREATE INDEX IF NOT EXISTS idx_phases_plan ON phases(plan_id);

CREATE TABLE IF NOT EXISTS plan_tasks (
    id TEXT PRIMARY KEY,
    phase_id TEXT NOT NULL REFERENCES phases(id) ON DELETE CASCADE,
    plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    task_order INTEGER NOT NULL,
    todo_task_id TEXT,
    pr_number INTEGER,
    pr_merged INTEGER DEFAULT 0,
    branch_name TEXT,
    agent_type TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    metadata TEXT,
    CONSTRAINT valid_task_status CHECK (status IN ('pending','blocked','ready','in_progress','completed','skipped'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_phase ON plan_tasks(phase_id);
CREATE INDEX IF NOT EXISTS idx_tasks_plan ON plan_tasks(plan_id);

CREATE TABLE IF NOT EXISTS substeps (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES plan_tasks(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0,
    step_order INTEGER NOT NULL,
    completed_at TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_substeps_task ON substeps(task_id);

CREATE TABLE IF NOT EXISTS dependencies (
    id TEXT PRIMARY KEY,
    blocker_type TEXT NOT NULL,
    blocker_id TEXT NOT NULL,
    blocked_type TEXT NOT NULL,
    blocked_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CONSTRAINT valid_blocker_type CHECK (blocker_type IN ('phase','task')),
    CONSTRAINT valid_blocked_type CHECK (blocked_type IN ('phase','task')),
    UNIQUE(blocker_id, blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_deps_blocker ON dependencies(blocker_id);
CREATE INDEX IF NOT EXISTS idx_deps_blocked ON dependencies(blocked_id);

CREATE TABLE IF NOT EXISTS state_changes (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    field_name TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    changed_at TEXT NOT NULL,
    changed_by TEXT,
    CONSTRAINT valid_entity_type CHECK (entity_type IN ('plan','phase','task','substep'))
);

CREATE INDEX IF NOT EXISTS idx_changes_entity ON state_changes(entity_id);
CREATE INDEX IF NOT EXISTS idx_changes_time ON state_changes(changed_at);
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
  db.exec(SCHEMA);
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

function recordStateChange(
  db: Database.Database,
  entityType: string,
  entityId: string,
  fieldName: string,
  oldValue: string | null,
  newValue: string | null,
  changedBy?: string | null,
): void {
  db.prepare(
    'INSERT INTO state_changes (id, entity_type, entity_id, field_name, old_value, new_value, changed_at, changed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(randomUUID(), entityType, entityId, fieldName, oldValue, newValue, now(), changedBy ?? null);
}

function getTaskProgress(db: Database.Database, taskId: string): number {
  const total = (db.prepare('SELECT COUNT(*) as c FROM substeps WHERE task_id = ?').get(taskId) as { c: number }).c;
  if (total === 0) {
    const task = db.prepare('SELECT status FROM plan_tasks WHERE id = ?').get(taskId) as { status: string } | undefined;
    return task?.status === 'completed' || task?.status === 'skipped' ? 100 : 0;
  }
  const completed = (db.prepare('SELECT COUNT(*) as c FROM substeps WHERE task_id = ? AND completed = 1').get(taskId) as { c: number }).c;
  return Math.round((completed / total) * 100);
}

function getPhaseProgress(db: Database.Database, phaseId: string): number {
  const tasks = db.prepare('SELECT id, status FROM plan_tasks WHERE phase_id = ?').all(phaseId) as Array<{ id: string; status: string }>;
  if (tasks.length === 0) return 0;
  const progresses = tasks.map(t => getTaskProgress(db, t.id));
  return Math.round(progresses.reduce((a, b) => a + b, 0) / progresses.length);
}

function getPlanProgress(db: Database.Database, planId: string): number {
  const phases = db.prepare("SELECT id, status FROM phases WHERE plan_id = ? AND status != 'skipped'").all(planId) as Array<{ id: string; status: string }>;
  if (phases.length === 0) return 0;
  const progresses = phases.map(p => getPhaseProgress(db, p.id));
  return Math.round(progresses.reduce((a, b) => a + b, 0) / progresses.length);
}

function isEntityCompleted(db: Database.Database, entityType: string, entityId: string): boolean {
  if (entityType === 'phase') {
    const phase = db.prepare('SELECT status FROM phases WHERE id = ?').get(entityId) as { status: string } | undefined;
    return phase?.status === 'completed' || phase?.status === 'skipped';
  }
  if (entityType === 'task') {
    const task = db.prepare('SELECT status FROM plan_tasks WHERE id = ?').get(entityId) as { status: string } | undefined;
    return task?.status === 'completed' || task?.status === 'skipped';
  }
  return false;
}

/**
 * Cycle detection via DFS.
 * Returns true if adding blocker->blocked would create a cycle.
 */
function wouldCreateCycle(db: Database.Database, blockerId: string, blockedId: string): boolean {
  const visited = new Set<string>();
  const stack = [blockedId];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === blockerId) return true;
    if (visited.has(current)) continue;
    visited.add(current);

    // Follow edges where current is the blocker
    const edges = db.prepare('SELECT blocked_id FROM dependencies WHERE blocker_id = ?').all(current) as Array<{ blocked_id: string }>;
    for (const edge of edges) {
      stack.push(edge.blocked_id);
    }
  }
  return false;
}

/**
 * Check if all dependencies for an entity are met.
 */
function areDependenciesMet(db: Database.Database, entityId: string, entityType: string): boolean {
  const deps = db.prepare(
    'SELECT blocker_type, blocker_id FROM dependencies WHERE blocked_id = ? AND blocked_type = ?'
  ).all(entityId, entityType) as Array<{ blocker_type: string; blocker_id: string }>;

  for (const dep of deps) {
    if (!isEntityCompleted(db, dep.blocker_type, dep.blocker_id)) {
      return false;
    }
  }
  return true;
}

/**
 * Update task statuses based on dependencies.
 * Returns tasks that are ready to spawn.
 */
function updateAndGetReadyTasks(db: Database.Database, planId: string): PlanTaskRecord[] {
  const tasks = db.prepare(
    "SELECT * FROM plan_tasks WHERE plan_id = ? AND status IN ('pending', 'blocked')"
  ).all(planId) as PlanTaskRecord[];

  const readyTasks: PlanTaskRecord[] = [];
  const ts = now();

  for (const task of tasks) {
    // Check task-level deps
    const taskDepsMet = areDependenciesMet(db, task.id, 'task');
    // Check phase-level deps
    const phaseDepsMet = areDependenciesMet(db, task.phase_id, 'phase');
    // Phase must not be skipped
    const phase = db.prepare('SELECT status FROM phases WHERE id = ?').get(task.phase_id) as { status: string };
    if (phase.status === 'skipped') continue;

    if (taskDepsMet && phaseDepsMet) {
      if (task.status !== 'ready') {
        const oldStatus = task.status;
        db.prepare('UPDATE plan_tasks SET status = ?, updated_at = ? WHERE id = ?').run('ready', ts, task.id);
        recordStateChange(db, 'task', task.id, 'status', oldStatus, 'ready');
      }
      readyTasks.push({ ...task, status: 'ready' });
    } else if (task.status !== 'blocked') {
      const oldStatus = task.status;
      db.prepare('UPDATE plan_tasks SET status = ?, updated_at = ? WHERE id = ?').run('blocked', ts, task.id);
      recordStateChange(db, 'task', task.id, 'status', oldStatus, 'blocked');
    }
  }

  return readyTasks;
}

// ============================================================================
// Tool Implementations
// ============================================================================

function createPlan(args: CreatePlanArgs) {
  const db = getDb();
  const planId = randomUUID();
  const ts = now();

  const createPlanTx = db.transaction(() => {
    db.prepare(
      'INSERT INTO plans (id, title, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(planId, args.title, args.description ?? null, 'draft', ts, ts);

    if (args.phases) {
      for (let pi = 0; pi < args.phases.length; pi++) {
        const phase = args.phases[pi];
        const phaseId = randomUUID();
        db.prepare(
          'INSERT INTO phases (id, plan_id, title, description, phase_order, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(phaseId, planId, phase.title, phase.description ?? null, pi + 1, 'pending', ts, ts);

        if (phase.tasks) {
          for (let ti = 0; ti < phase.tasks.length; ti++) {
            const task = phase.tasks[ti];
            const taskId = randomUUID();
            db.prepare(
              'INSERT INTO plan_tasks (id, phase_id, plan_id, title, description, status, task_order, agent_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            ).run(taskId, phaseId, planId, task.title, task.description ?? null, 'pending', ti + 1, task.agent_type ?? null, ts, ts);

            if (task.substeps) {
              for (let si = 0; si < task.substeps.length; si++) {
                db.prepare(
                  'INSERT INTO substeps (id, task_id, title, completed, step_order, created_at) VALUES (?, ?, ?, 0, ?, ?)'
                ).run(randomUUID(), taskId, task.substeps[si].title, si + 1, ts);
              }
            }
          }
        }
      }
    }

    recordStateChange(db, 'plan', planId, 'status', null, 'draft');
  });

  createPlanTx();

  const phaseCount = args.phases?.length ?? 0;
  const taskCount = args.phases?.reduce((sum, p) => sum + (p.tasks?.length ?? 0), 0) ?? 0;

  return {
    plan_id: planId,
    title: args.title,
    phases_created: phaseCount,
    tasks_created: taskCount,
    status: 'draft',
    created_at: ts,
  };
}

function getPlan(args: GetPlanArgs) {
  const db = getDb();
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(args.plan_id) as PlanRecord | undefined;
  if (!plan) return { error: `Plan not found: ${args.plan_id}` } as ErrorResult;

  const phases = db.prepare('SELECT * FROM phases WHERE plan_id = ? ORDER BY phase_order').all(args.plan_id) as PhaseRecord[];

  const phaseResults = phases.map(phase => {
    const tasks = db.prepare('SELECT * FROM plan_tasks WHERE phase_id = ? ORDER BY task_order').all(phase.id) as PlanTaskRecord[];

    const taskResults = tasks.map(task => {
      const taskResult: Record<string, unknown> = {
        id: task.id,
        title: task.title,
        description: task.description,
        status: task.status,
        task_order: task.task_order,
        agent_type: task.agent_type,
        todo_task_id: task.todo_task_id,
        pr_number: task.pr_number,
        pr_merged: task.pr_merged === 1,
        branch_name: task.branch_name,
        progress_pct: getTaskProgress(db, task.id),
      };

      if (args.include_substeps) {
        taskResult.substeps = db.prepare('SELECT * FROM substeps WHERE task_id = ? ORDER BY step_order').all(task.id);
      }

      return taskResult;
    });

    return {
      id: phase.id,
      title: phase.title,
      description: phase.description,
      phase_order: phase.phase_order,
      status: phase.status,
      progress_pct: getPhaseProgress(db, phase.id),
      tasks: taskResults,
    };
  });

  return {
    id: plan.id,
    title: plan.title,
    description: plan.description,
    status: plan.status,
    progress_pct: getPlanProgress(db, plan.id),
    created_at: plan.created_at,
    updated_at: plan.updated_at,
    started_at: plan.started_at,
    completed_at: plan.completed_at,
    phases: phaseResults,
  };
}

function listPlans(args: ListPlansArgs) {
  const db = getDb();
  let plans: PlanRecord[];

  if (args.status) {
    plans = db.prepare('SELECT * FROM plans WHERE status = ? ORDER BY updated_at DESC').all(args.status) as PlanRecord[];
  } else {
    plans = db.prepare('SELECT * FROM plans ORDER BY updated_at DESC').all() as PlanRecord[];
  }

  return {
    plans: plans.map(p => {
      const phaseCount = (db.prepare('SELECT COUNT(*) as c FROM phases WHERE plan_id = ?').get(p.id) as { c: number }).c;
      const taskCount = (db.prepare('SELECT COUNT(*) as c FROM plan_tasks WHERE plan_id = ?').get(p.id) as { c: number }).c;
      const completedTasks = (db.prepare("SELECT COUNT(*) as c FROM plan_tasks WHERE plan_id = ? AND status = 'completed'").get(p.id) as { c: number }).c;
      const readyTasks = (db.prepare("SELECT COUNT(*) as c FROM plan_tasks WHERE plan_id = ? AND status = 'ready'").get(p.id) as { c: number }).c;

      return {
        id: p.id,
        title: p.title,
        status: p.status,
        progress_pct: getPlanProgress(db, p.id),
        phases: phaseCount,
        tasks: `${completedTasks}/${taskCount}`,
        ready_to_spawn: readyTasks,
        updated_at: p.updated_at,
      };
    }),
    total: plans.length,
  };
}

function updatePlanStatus(args: UpdatePlanStatusArgs) {
  const db = getDb();
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(args.plan_id) as PlanRecord | undefined;
  if (!plan) return { error: `Plan not found: ${args.plan_id}` } as ErrorResult;

  const ts = now();
  const updates: Record<string, string | null> = { status: args.status, updated_at: ts };

  if (args.status === 'active' && !plan.started_at) {
    updates.started_at = ts;
  }
  if (args.status === 'completed') {
    updates.completed_at = ts;
  }

  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE plans SET ${setClauses} WHERE id = ?`).run(...Object.values(updates), args.plan_id);

  recordStateChange(db, 'plan', args.plan_id, 'status', plan.status, args.status);

  // When activating, update task statuses
  if (args.status === 'active') {
    updateAndGetReadyTasks(db, args.plan_id);
  }

  return {
    plan_id: args.plan_id,
    old_status: plan.status,
    new_status: args.status,
    updated_at: ts,
  };
}

function addPhase(args: AddPhaseArgs) {
  const db = getDb();
  const plan = db.prepare('SELECT id FROM plans WHERE id = ?').get(args.plan_id) as { id: string } | undefined;
  if (!plan) return { error: `Plan not found: ${args.plan_id}` } as ErrorResult;

  const maxOrder = (db.prepare('SELECT MAX(phase_order) as m FROM phases WHERE plan_id = ?').get(args.plan_id) as { m: number | null }).m ?? 0;
  const phaseId = randomUUID();
  const ts = now();

  db.prepare(
    'INSERT INTO phases (id, plan_id, title, description, phase_order, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(phaseId, args.plan_id, args.title, args.description ?? null, maxOrder + 1, 'pending', ts, ts);

  // Add phase-level dependencies
  if (args.blocked_by) {
    for (const blockerId of args.blocked_by) {
      const depId = randomUUID();
      db.prepare(
        'INSERT INTO dependencies (id, blocker_type, blocker_id, blocked_type, blocked_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(depId, 'phase', blockerId, 'phase', phaseId, ts);
    }
  }

  return {
    phase_id: phaseId,
    plan_id: args.plan_id,
    title: args.title,
    phase_order: maxOrder + 1,
    created_at: ts,
  };
}

function updatePhase(args: UpdatePhaseArgs) {
  const db = getDb();
  const phase = db.prepare('SELECT * FROM phases WHERE id = ?').get(args.phase_id) as PhaseRecord | undefined;
  if (!phase) return { error: `Phase not found: ${args.phase_id}` } as ErrorResult;

  const ts = now();
  const updates: string[] = ['updated_at = ?'];
  const values: (string | null)[] = [ts];

  if (args.title) {
    updates.push('title = ?');
    values.push(args.title);
  }

  if (args.status) {
    updates.push('status = ?');
    values.push(args.status);
    recordStateChange(db, 'phase', args.phase_id, 'status', phase.status, args.status);

    if (args.status === 'in_progress' && !phase.started_at) {
      updates.push('started_at = ?');
      values.push(ts);
    }
    if (args.status === 'completed') {
      updates.push('completed_at = ?');
      values.push(ts);
    }
  }

  db.prepare(`UPDATE phases SET ${updates.join(', ')} WHERE id = ?`).run(...values, args.phase_id);

  // Update downstream task statuses
  if (args.status) {
    updateAndGetReadyTasks(db, phase.plan_id);
  }

  return {
    phase_id: args.phase_id,
    updated_at: ts,
    status: args.status ?? phase.status,
  };
}

function addPlanTask(args: AddPlanTaskArgs) {
  const db = getDb();
  const phase = db.prepare('SELECT * FROM phases WHERE id = ?').get(args.phase_id) as PhaseRecord | undefined;
  if (!phase) return { error: `Phase not found: ${args.phase_id}` } as ErrorResult;

  const maxOrder = (db.prepare('SELECT MAX(task_order) as m FROM plan_tasks WHERE phase_id = ?').get(args.phase_id) as { m: number | null }).m ?? 0;
  const taskId = randomUUID();
  const ts = now();

  const addTaskTx = db.transaction(() => {
    db.prepare(
      'INSERT INTO plan_tasks (id, phase_id, plan_id, title, description, status, task_order, agent_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(taskId, args.phase_id, phase.plan_id, args.title, args.description ?? null, 'pending', maxOrder + 1, args.agent_type ?? null, ts, ts);

    // Add substeps
    if (args.substeps) {
      for (let i = 0; i < args.substeps.length; i++) {
        db.prepare(
          'INSERT INTO substeps (id, task_id, title, completed, step_order, created_at) VALUES (?, ?, ?, 0, ?, ?)'
        ).run(randomUUID(), taskId, args.substeps[i].title, i + 1, ts);
      }
    }

    // Add task-level dependencies
    if (args.blocked_by) {
      for (const blockerId of args.blocked_by) {
        db.prepare(
          'INSERT INTO dependencies (id, blocker_type, blocker_id, blocked_type, blocked_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(randomUUID(), 'task', blockerId, 'task', taskId, ts);
      }
    }
  });

  addTaskTx();

  // Create linked todo-db task AFTER plans.db transaction succeeds
  // (prevents orphaned todo tasks if the transaction rolls back)
  if (args.create_todo && fs.existsSync(TODO_DB_PATH)) {
    try {
      const todoDb = new Database(TODO_DB_PATH);
      todoDb.pragma('journal_mode = WAL');
      const todoTaskId = randomUUID();
      const metadata = JSON.stringify({ plan_task_id: taskId, plan_id: phase.plan_id });
      todoDb.prepare(
        "INSERT INTO tasks (id, section, status, title, description, assigned_by, created_at, created_timestamp, metadata, followup_enabled) VALUES (?, ?, 'pending', ?, ?, 'plan-orchestrator', ?, ?, ?, 0)"
      ).run(todoTaskId, args.todo_section ?? 'GENERAL', args.title, args.description ?? null, ts, ts, metadata);
      todoDb.close();

      // Store linkage on plan_tasks
      db.prepare('UPDATE plan_tasks SET todo_task_id = ? WHERE id = ?').run(todoTaskId, taskId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[plan-orchestrator] Warning: Could not create todo task: ${message}\n`);
    }
  }

  return {
    task_id: taskId,
    phase_id: args.phase_id,
    plan_id: phase.plan_id,
    title: args.title,
    task_order: maxOrder + 1,
    substeps_created: args.substeps?.length ?? 0,
    created_at: ts,
  };
}

function updateTaskProgress(args: UpdateTaskProgressArgs) {
  const db = getDb();
  const task = db.prepare('SELECT * FROM plan_tasks WHERE id = ?').get(args.task_id) as PlanTaskRecord | undefined;
  if (!task) return { error: `Task not found: ${args.task_id}` } as ErrorResult;

  const ts = now();
  const updates: string[] = ['updated_at = ?'];
  const values: (string | number | null)[] = [ts];

  if (args.status) {
    updates.push('status = ?');
    values.push(args.status);
    recordStateChange(db, 'task', args.task_id, 'status', task.status, args.status);

    if (args.status === 'in_progress' && !task.started_at) {
      updates.push('started_at = ?');
      values.push(ts);
    }
    if (args.status === 'completed') {
      updates.push('completed_at = ?');
      values.push(ts);
    }
  }

  if (args.pr_number !== undefined) {
    updates.push('pr_number = ?');
    values.push(args.pr_number);
  }

  if (args.branch_name !== undefined) {
    updates.push('branch_name = ?');
    values.push(args.branch_name);
  }

  if (args.pr_merged !== undefined) {
    updates.push('pr_merged = ?');
    values.push(args.pr_merged ? 1 : 0);

    // Auto-complete on PR merge (only if no explicit status was provided)
    if (args.pr_merged && !args.status && task.status !== 'completed') {
      updates.push('status = ?');
      values.push('completed');
      updates.push('completed_at = ?');
      values.push(ts);
      recordStateChange(db, 'task', args.task_id, 'status', task.status, 'completed');
    }
  }

  db.prepare(`UPDATE plan_tasks SET ${updates.join(', ')} WHERE id = ?`).run(...values, args.task_id);

  // Check if phase should auto-complete
  const phase = db.prepare('SELECT * FROM phases WHERE id = ?').get(task.phase_id) as PhaseRecord;
  const allTasks = db.prepare('SELECT status FROM plan_tasks WHERE phase_id = ?').all(task.phase_id) as Array<{ status: string }>;
  const allDone = allTasks.every(t => t.status === 'completed' || t.status === 'skipped');
  if (allDone && phase.status !== 'completed') {
    db.prepare("UPDATE phases SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?").run(ts, ts, task.phase_id);
    recordStateChange(db, 'phase', task.phase_id, 'status', phase.status, 'completed');
  }

  // Update downstream tasks
  const readyTasks = updateAndGetReadyTasks(db, task.plan_id);

  // Check if plan should auto-complete
  const allPhases = db.prepare('SELECT status FROM phases WHERE plan_id = ?').all(task.plan_id) as Array<{ status: string }>;
  const planDone = allPhases.every(p => p.status === 'completed' || p.status === 'skipped');
  if (planDone) {
    const plan = db.prepare('SELECT status FROM plans WHERE id = ?').get(task.plan_id) as { status: string };
    if (plan.status === 'active') {
      db.prepare("UPDATE plans SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?").run(ts, ts, task.plan_id);
      recordStateChange(db, 'plan', task.plan_id, 'status', 'active', 'completed');
    }
  }

  return {
    task_id: args.task_id,
    updated_at: ts,
    progress_pct: getTaskProgress(db, args.task_id),
    newly_ready: readyTasks.map(t => ({ id: t.id, title: t.title, agent_type: t.agent_type })),
  };
}

function linkTask(args: LinkTaskArgs) {
  const db = getDb();
  const task = db.prepare('SELECT id FROM plan_tasks WHERE id = ?').get(args.plan_task_id) as { id: string } | undefined;
  if (!task) return { error: `Plan task not found: ${args.plan_task_id}` } as ErrorResult;

  db.prepare('UPDATE plan_tasks SET todo_task_id = ?, updated_at = ? WHERE id = ?').run(args.todo_task_id, now(), args.plan_task_id);

  return {
    plan_task_id: args.plan_task_id,
    todo_task_id: args.todo_task_id,
    linked: true,
  };
}

function addSubsteps(args: AddSubstepsArgs) {
  const db = getDb();
  const task = db.prepare('SELECT id FROM plan_tasks WHERE id = ?').get(args.task_id) as { id: string } | undefined;
  if (!task) return { error: `Task not found: ${args.task_id}` } as ErrorResult;

  const maxOrder = (db.prepare('SELECT MAX(step_order) as m FROM substeps WHERE task_id = ?').get(args.task_id) as { m: number | null }).m ?? 0;
  const ts = now();
  const ids: string[] = [];

  for (let i = 0; i < args.substeps.length; i++) {
    const id = randomUUID();
    db.prepare(
      'INSERT INTO substeps (id, task_id, title, completed, step_order, created_at) VALUES (?, ?, ?, 0, ?, ?)'
    ).run(id, args.task_id, args.substeps[i].title, maxOrder + i + 1, ts);
    ids.push(id);
  }

  return {
    task_id: args.task_id,
    substep_ids: ids,
    total_substeps: maxOrder + args.substeps.length,
  };
}

function completeSubstep(args: CompleteSubstepArgs) {
  const db = getDb();
  const substep = db.prepare('SELECT * FROM substeps WHERE id = ?').get(args.substep_id) as SubstepRecord | undefined;
  if (!substep) return { error: `Substep not found: ${args.substep_id}` } as ErrorResult;

  if (substep.completed) {
    return { error: `Substep already completed: ${args.substep_id}` } as ErrorResult;
  }

  const ts = now();
  db.prepare('UPDATE substeps SET completed = 1, completed_at = ? WHERE id = ?').run(ts, args.substep_id);
  recordStateChange(db, 'substep', args.substep_id, 'completed', '0', '1');

  const progress = getTaskProgress(db, substep.task_id);
  const total = (db.prepare('SELECT COUNT(*) as c FROM substeps WHERE task_id = ?').get(substep.task_id) as { c: number }).c;
  const completed = (db.prepare('SELECT COUNT(*) as c FROM substeps WHERE task_id = ? AND completed = 1').get(substep.task_id) as { c: number }).c;

  return {
    substep_id: args.substep_id,
    task_id: substep.task_id,
    completed_at: ts,
    task_progress: `${completed}/${total} (${progress}%)`,
  };
}

function addDependency(args: AddDependencyArgs) {
  const db = getDb();

  // Validate entities exist
  if (args.blocker_type === 'phase') {
    if (!db.prepare('SELECT id FROM phases WHERE id = ?').get(args.blocker_id)) {
      return { error: `Blocker phase not found: ${args.blocker_id}` } as ErrorResult;
    }
  } else {
    if (!db.prepare('SELECT id FROM plan_tasks WHERE id = ?').get(args.blocker_id)) {
      return { error: `Blocker task not found: ${args.blocker_id}` } as ErrorResult;
    }
  }

  if (args.blocked_type === 'phase') {
    if (!db.prepare('SELECT id FROM phases WHERE id = ?').get(args.blocked_id)) {
      return { error: `Blocked phase not found: ${args.blocked_id}` } as ErrorResult;
    }
  } else {
    if (!db.prepare('SELECT id FROM plan_tasks WHERE id = ?').get(args.blocked_id)) {
      return { error: `Blocked task not found: ${args.blocked_id}` } as ErrorResult;
    }
  }

  // Cycle detection
  if (wouldCreateCycle(db, args.blocker_id, args.blocked_id)) {
    return { error: 'Adding this dependency would create a cycle' } as ErrorResult;
  }

  // Check for existing
  const existing = db.prepare(
    'SELECT id FROM dependencies WHERE blocker_id = ? AND blocked_id = ?'
  ).get(args.blocker_id, args.blocked_id);
  if (existing) {
    return { error: 'Dependency already exists' } as ErrorResult;
  }

  const depId = randomUUID();
  db.prepare(
    'INSERT INTO dependencies (id, blocker_type, blocker_id, blocked_type, blocked_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(depId, args.blocker_type, args.blocker_id, args.blocked_type, args.blocked_id, now());

  return {
    dependency_id: depId,
    blocker: `${args.blocker_type}:${args.blocker_id}`,
    blocked: `${args.blocked_type}:${args.blocked_id}`,
  };
}

function getSpawnReadyTasks(args: GetSpawnReadyTasksArgs) {
  const db = getDb();
  const plan = db.prepare('SELECT id, status FROM plans WHERE id = ?').get(args.plan_id) as PlanRecord | undefined;
  if (!plan) return { error: `Plan not found: ${args.plan_id}` } as ErrorResult;
  if (plan.status !== 'active') {
    return { error: `Plan is not active (status: ${plan.status}). Activate it first.` } as ErrorResult;
  }

  const readyTasks = updateAndGetReadyTasks(db, args.plan_id);

  return {
    plan_id: args.plan_id,
    ready_tasks: readyTasks.map(t => {
      const phase = db.prepare('SELECT title FROM phases WHERE id = ?').get(t.phase_id) as { title: string };
      return {
        id: t.id,
        title: t.title,
        description: t.description,
        agent_type: t.agent_type,
        phase: phase.title,
        todo_task_id: t.todo_task_id,
      };
    }),
    count: readyTasks.length,
  };
}

function planDashboard(args: PlanDashboardArgs) {
  const db = getDb();
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(args.plan_id) as PlanRecord | undefined;
  if (!plan) return { error: `Plan not found: ${args.plan_id}` } as ErrorResult;

  const phases = db.prepare('SELECT * FROM phases WHERE plan_id = ? ORDER BY phase_order').all(args.plan_id) as PhaseRecord[];

  const lines: string[] = [];
  lines.push(`\u2550\u2550\u2550 ${plan.title} \u2550\u2550\u2550`);
  lines.push(`Status: ${formatStatus(plan.status)} | Progress: ${progressBar(getPlanProgress(db, plan.id))}`);
  lines.push('');

  for (const phase of phases) {
    const phaseProg = getPhaseProgress(db, phase.id);
    lines.push(`Phase ${phase.phase_order}: ${phase.title}  ${formatStatus(phase.status)}`);
    lines.push(`  ${progressBar(phaseProg)}`);

    const tasks = db.prepare('SELECT * FROM plan_tasks WHERE phase_id = ? ORDER BY task_order').all(phase.id) as PlanTaskRecord[];
    for (const task of tasks) {
      const taskProg = getTaskProgress(db, task.id);
      const agentLabel = task.agent_type ? ` [${task.agent_type}]` : '';
      const prLabel = task.pr_number ? ` PR #${task.pr_number}${task.pr_merged ? ' merged' : ''}` : '';
      lines.push(`    ${task.title}  ${formatStatus(task.status)}${agentLabel}${prLabel}`);
      lines.push(`      ${progressBar(taskProg, 15)}`);

      // Substeps
      const substeps = db.prepare('SELECT * FROM substeps WHERE task_id = ? ORDER BY step_order').all(task.id) as SubstepRecord[];
      for (const ss of substeps) {
        lines.push(`      ${substepIndicator(ss.completed === 1)} ${ss.title}`);
      }
    }
    lines.push('');
  }

  // Summary
  const totalTasks = (db.prepare('SELECT COUNT(*) as c FROM plan_tasks WHERE plan_id = ?').get(args.plan_id) as { c: number }).c;
  const completedTasks = (db.prepare("SELECT COUNT(*) as c FROM plan_tasks WHERE plan_id = ? AND status = 'completed'").get(args.plan_id) as { c: number }).c;
  const readyTasks = (db.prepare("SELECT COUNT(*) as c FROM plan_tasks WHERE plan_id = ? AND status = 'ready'").get(args.plan_id) as { c: number }).c;
  const activeTasks = (db.prepare("SELECT COUNT(*) as c FROM plan_tasks WHERE plan_id = ? AND status = 'in_progress'").get(args.plan_id) as { c: number }).c;

  lines.push(`Tasks: ${completedTasks}/${totalTasks} complete | ${readyTasks} ready | ${activeTasks} active`);

  return { dashboard: lines.join('\n') };
}

function planTimeline(args: PlanTimelineArgs) {
  const db = getDb();
  const plan = db.prepare('SELECT id FROM plans WHERE id = ?').get(args.plan_id) as { id: string } | undefined;
  if (!plan) return { error: `Plan not found: ${args.plan_id}` } as ErrorResult;

  const since = new Date(Date.now() - args.hours * 60 * 60 * 1000).toISOString();

  let query = `
    SELECT sc.* FROM state_changes sc
    WHERE sc.changed_at >= ?
    AND sc.entity_id IN (
      SELECT id FROM plans WHERE id = ?
      UNION SELECT id FROM phases WHERE plan_id = ?
      UNION SELECT id FROM plan_tasks WHERE plan_id = ?
      UNION SELECT s.id FROM substeps s JOIN plan_tasks t ON s.task_id = t.id WHERE t.plan_id = ?
    )
  `;
  const params: string[] = [since, args.plan_id, args.plan_id, args.plan_id, args.plan_id];

  if (args.entity_type) {
    query += ' AND sc.entity_type = ?';
    params.push(args.entity_type);
  }

  query += ' ORDER BY sc.changed_at DESC LIMIT 50';

  const changes = db.prepare(query).all(...params) as StateChangeRecord[];

  const entries: TimelineEntry[] = changes.map(c => {
    // Resolve entity name
    let label = c.entity_id.substring(0, 8);
    if (c.entity_type === 'task') {
      const task = db.prepare('SELECT title FROM plan_tasks WHERE id = ?').get(c.entity_id) as { title: string } | undefined;
      if (task) label = task.title;
    } else if (c.entity_type === 'phase') {
      const phase = db.prepare('SELECT title FROM phases WHERE id = ?').get(c.entity_id) as { title: string } | undefined;
      if (phase) label = phase.title;
    } else if (c.entity_type === 'substep') {
      const ss = db.prepare('SELECT title FROM substeps WHERE id = ?').get(c.entity_id) as { title: string } | undefined;
      if (ss) label = ss.title;
    } else if (c.entity_type === 'plan') {
      label = plan.id === c.entity_id ? 'Plan' : c.entity_id.substring(0, 8);
    }

    return {
      time: c.changed_at,
      label,
      action: c.new_value ?? 'changed',
      detail: c.old_value ? `${c.field_name}: ${c.old_value} -> ${c.new_value}` : `${c.field_name}: ${c.new_value}`,
      indent: c.entity_type === 'substep',
    };
  });

  return {
    plan_id: args.plan_id,
    hours: args.hours,
    events: entries.length,
    timeline: formatTimeline(entries),
  };
}

function planAudit(args: PlanAuditArgs) {
  const db = getDb();
  const plan = db.prepare('SELECT id, title FROM plans WHERE id = ?').get(args.plan_id) as { id: string; title: string } | undefined;
  if (!plan) return { error: `Plan not found: ${args.plan_id}` } as ErrorResult;

  // Get all tasks with their agents
  const tasks = db.prepare('SELECT * FROM plan_tasks WHERE plan_id = ? ORDER BY task_order').all(args.plan_id) as PlanTaskRecord[];

  // Try to get worklog data for linked tasks
  const agentMetrics: Record<string, {
    agent_type: string;
    tasks_assigned: number;
    tasks_completed: number;
    total_tokens: number;
    total_duration_ms: number;
    prs_merged: number;
  }> = {};

  for (const task of tasks) {
    const agentType = task.agent_type || 'unassigned';
    if (!agentMetrics[agentType]) {
      agentMetrics[agentType] = {
        agent_type: agentType,
        tasks_assigned: 0,
        tasks_completed: 0,
        total_tokens: 0,
        total_duration_ms: 0,
        prs_merged: 0,
      };
    }
    agentMetrics[agentType].tasks_assigned++;
    if (task.status === 'completed') agentMetrics[agentType].tasks_completed++;
    if (task.pr_merged) agentMetrics[agentType].prs_merged++;

    // Try worklog lookup
    if (task.todo_task_id && fs.existsSync(WORKLOG_DB_PATH)) {
      try {
        const wlDb = new Database(WORKLOG_DB_PATH, { readonly: true });
        const entry = wlDb.prepare(
          'SELECT tokens_total, duration_start_to_complete_ms FROM worklog_entries WHERE task_id = ?'
        ).get(task.todo_task_id) as { tokens_total: number | null; duration_start_to_complete_ms: number | null } | undefined;
        wlDb.close();

        if (entry) {
          agentMetrics[agentType].total_tokens += entry.tokens_total ?? 0;
          agentMetrics[agentType].total_duration_ms += entry.duration_start_to_complete_ms ?? 0;
        }
      } catch {
        // Non-fatal
      }
    }
  }

  // Format as table
  const lines: string[] = [];
  lines.push(`Plan Audit: ${plan.title}`);
  lines.push('');
  lines.push(`${'Agent Type'.padEnd(20)} ${'Assigned'.padStart(8)} ${'Done'.padStart(6)} ${'PRs'.padStart(5)} ${'Tokens'.padStart(8)} ${'Duration'.padStart(10)}`);
  lines.push('-'.repeat(65));

  for (const m of Object.values(agentMetrics)) {
    lines.push(
      `${m.agent_type.padEnd(20)} ${String(m.tasks_assigned).padStart(8)} ${String(m.tasks_completed).padStart(6)} ${String(m.prs_merged).padStart(5)} ${formatTokens(m.total_tokens).padStart(8)} ${m.total_duration_ms > 0 ? formatTimeAgo(new Date(Date.now() - m.total_duration_ms).toISOString()).padStart(10) : '-'.padStart(10)}`
    );
  }

  // Phase efficiency
  lines.push('');
  lines.push('Phase Efficiency:');
  const phases = db.prepare('SELECT * FROM phases WHERE plan_id = ? ORDER BY phase_order').all(args.plan_id) as PhaseRecord[];
  for (const phase of phases) {
    const phaseTasks = db.prepare('SELECT COUNT(*) as c FROM plan_tasks WHERE phase_id = ?').get(phase.id) as { c: number };
    const phaseCompleted = db.prepare("SELECT COUNT(*) as c FROM plan_tasks WHERE phase_id = ? AND status = 'completed'").get(phase.id) as { c: number };
    lines.push(`  Phase ${phase.phase_order}: ${phase.title} - ${phaseCompleted.c}/${phaseTasks.c} tasks (${getPhaseProgress(db, phase.id)}%)`);
  }

  return { audit: lines.join('\n') };
}

// ============================================================================
// Server Setup
// ============================================================================

const tools: AnyToolHandler[] = [
  {
    name: 'create_plan',
    description: 'Create a new plan with optional inline phases, tasks, and substeps.',
    schema: CreatePlanArgsSchema,
    handler: createPlan,
  },
  {
    name: 'get_plan',
    description: 'Get full plan tree with phases, tasks, substeps, and progress percentages.',
    schema: GetPlanArgsSchema,
    handler: getPlan,
  },
  {
    name: 'list_plans',
    description: 'List all plans with overall progress. Optionally filter by status.',
    schema: ListPlansArgsSchema,
    handler: listPlans,
  },
  {
    name: 'update_plan_status',
    description: 'Update plan status (draft/active/paused/completed/archived). Activating updates task readiness.',
    schema: UpdatePlanStatusArgsSchema,
    handler: updatePlanStatus,
  },
  {
    name: 'add_phase',
    description: 'Add a phase to an existing plan. Auto-assigns order. Optional blocked_by for dependencies.',
    schema: AddPhaseArgsSchema,
    handler: addPhase,
  },
  {
    name: 'update_phase',
    description: 'Update phase title or status. Status changes are recorded in state_changes.',
    schema: UpdatePhaseArgsSchema,
    handler: updatePhase,
  },
  {
    name: 'add_plan_task',
    description: 'Add a task to a phase. Optionally create a linked todo-db task and add inline substeps.',
    schema: AddPlanTaskArgsSchema,
    handler: addPlanTask,
  },
  {
    name: 'update_task_progress',
    description: 'Update task status, PR info, or branch. Auto-completes on pr_merged=true. Returns newly ready tasks.',
    schema: UpdateTaskProgressArgsSchema,
    handler: updateTaskProgress,
  },
  {
    name: 'link_task',
    description: 'Link a plan task to an existing todo-db task by ID.',
    schema: LinkTaskArgsSchema,
    handler: linkTask,
  },
  {
    name: 'add_substeps',
    description: 'Batch add substeps to a task.',
    schema: AddSubstepsArgsSchema,
    handler: addSubsteps,
  },
  {
    name: 'complete_substep',
    description: 'Mark a substep as complete. Returns updated task progress.',
    schema: CompleteSubstepArgsSchema,
    handler: completeSubstep,
  },
  {
    name: 'add_dependency',
    description: 'Add a dependency between phases or tasks. Validates no cycles via DFS.',
    schema: AddDependencyArgsSchema,
    handler: addDependency,
  },
  {
    name: 'get_spawn_ready_tasks',
    description: 'Get tasks whose dependencies are all met. Updates statuses and returns ready tasks.',
    schema: GetSpawnReadyTasksArgsSchema,
    handler: getSpawnReadyTasks,
  },
  {
    name: 'plan_dashboard',
    description: 'Formatted progress dashboard with phases, tasks, substeps, and progress bars.',
    schema: PlanDashboardArgsSchema,
    handler: planDashboard,
  },
  {
    name: 'plan_timeline',
    description: 'State changes timeline with compact arrow format. Filter by hours and entity type.',
    schema: PlanTimelineArgsSchema,
    handler: planTimeline,
  },
  {
    name: 'plan_audit',
    description: 'Agent work metrics per plan with phase efficiency breakdown. Cross-references worklog.',
    schema: PlanAuditArgsSchema,
    handler: planAudit,
  },
];

const server = new McpServer({
  name: 'plan-orchestrator',
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
