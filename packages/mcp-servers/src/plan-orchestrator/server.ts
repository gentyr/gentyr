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
  PlanSessionsArgsSchema,
  ForceClosePlanArgsSchema,
  CheckVerificationAuditArgsSchema,
  VerificationAuditPassArgsSchema,
  VerificationAuditFailArgsSchema,
  GetPlanBlockingStatusArgsSchema,
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
  type PlanSessionsArgs,
  type ForceClosePlanArgs,
  type CheckVerificationAuditArgs,
  type VerificationAuditPassArgs,
  type VerificationAuditFailArgs,
  type GetPlanBlockingStatusArgs,
  type PlanRecord,
  type PhaseRecord,
  type PlanTaskRecord,
  type SubstepRecord,
  type StateChangeRecord,
  type PlanAuditRecord,
  type ErrorResult,
} from './types.js';
import {
  progressBar,
  substepIndicator,
  formatStatus,
  formatTimeAgo,
  formatTokens,
  formatDuration,
  formatCompactTime,
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
    CONSTRAINT valid_plan_status CHECK (status IN ('draft','active','paused','completed','archived','cancelled'))
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
    verification_strategy TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    metadata TEXT,
    CONSTRAINT valid_task_status CHECK (status IN ('pending','blocked','ready','in_progress','pending_audit','completed','skipped'))
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

CREATE TABLE IF NOT EXISTS plan_audits (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES plan_tasks(id) ON DELETE CASCADE,
    plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    verification_strategy TEXT NOT NULL,
    verdict TEXT,
    evidence TEXT,
    failure_reason TEXT,
    auditor_agent_id TEXT,
    requested_at TEXT NOT NULL,
    completed_at TEXT,
    attempt_number INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT valid_audit_verdict CHECK (verdict IS NULL OR verdict IN ('pass','fail'))
);

CREATE INDEX IF NOT EXISTS idx_audits_task ON plan_audits(task_id);
CREATE INDEX IF NOT EXISTS idx_audits_pending ON plan_audits(verdict) WHERE verdict IS NULL;
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

  // ── plans table: CHECK constraint migration (add 'cancelled') ──────────────
  // Check sqlite_master directly instead of test-INSERT (avoids fragile catch-all
  // that can leave plans_old orphans on partial failure).
  const plansSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='plans'").get() as { sql: string } | undefined)?.sql ?? '';
  const needsCheckMigration = plansSql && !plansSql.includes("'cancelled'");

  if (needsCheckMigration) {
    db.pragma('foreign_keys = OFF');
    // Prevent ALTER TABLE RENAME from rewriting FK references in child tables
    // (phases, plan_tasks). Without this, SQLite auto-updates their FKs from
    // "plans" to "plans_old", leaving dangling references after we drop plans_old.
    db.pragma('legacy_alter_table = ON');
    // Guard: drop leftover plans_old from any previous failed migration
    db.exec('DROP TABLE IF EXISTS plans_old');
    const migrate = db.transaction(() => {
      db.exec('ALTER TABLE plans RENAME TO plans_old');
      db.exec(`
        CREATE TABLE plans (
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
            persistent_task_id TEXT,
            manager_agent_id TEXT,
            manager_pid INTEGER,
            manager_session_id TEXT,
            last_heartbeat TEXT,
            CONSTRAINT valid_plan_status CHECK (status IN ('draft','active','paused','completed','archived','cancelled'))
        )
      `);
      db.exec(`
        INSERT INTO plans (id, title, description, status, created_at, updated_at, started_at, completed_at, created_by, metadata)
          SELECT id, title, description, status, created_at, updated_at, started_at, completed_at, created_by, metadata FROM plans_old
      `);
      db.exec('DROP TABLE plans_old');
    });
    migrate();
    db.pragma('legacy_alter_table = OFF');
    db.pragma('foreign_keys = ON');
  }

  // ── Repair FK corruption from previous ALTER TABLE RENAME ───────────────
  // A previous migration (before legacy_alter_table fix) renamed plans → plans_old,
  // which caused SQLite to rewrite FK references in phases and plan_tasks from
  // "plans" to "plans_old". Fix by surgically editing sqlite_master.
  const phasesSqlCheck = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='phases'").get() as { sql: string } | undefined)?.sql ?? '';
  if (phasesSqlCheck.includes('plans_old')) {
    db.pragma('foreign_keys = OFF');
    db.pragma('writable_schema = ON');
    db.prepare(
      `UPDATE sqlite_master SET sql = REPLACE(sql, '"plans_old"', 'plans') WHERE type = 'table' AND name IN ('phases', 'plan_tasks')`
    ).run();
    db.pragma('writable_schema = OFF');
    db.pragma('foreign_keys = ON');
  }

  // ── plans table: add marriage columns (idempotent) ─────────────────────────
  try {
    db.prepare('SELECT persistent_task_id FROM plans LIMIT 0').get();
  } catch {
    db.exec('ALTER TABLE plans ADD COLUMN persistent_task_id TEXT');
  }
  try {
    db.prepare('SELECT manager_agent_id FROM plans LIMIT 0').get();
  } catch {
    db.exec('ALTER TABLE plans ADD COLUMN manager_agent_id TEXT');
  }
  try {
    db.prepare('SELECT manager_pid FROM plans LIMIT 0').get();
  } catch {
    db.exec('ALTER TABLE plans ADD COLUMN manager_pid INTEGER');
  }
  try {
    db.prepare('SELECT manager_session_id FROM plans LIMIT 0').get();
  } catch {
    db.exec('ALTER TABLE plans ADD COLUMN manager_session_id TEXT');
  }
  try {
    db.prepare('SELECT last_heartbeat FROM plans LIMIT 0').get();
  } catch {
    db.exec('ALTER TABLE plans ADD COLUMN last_heartbeat TEXT');
  }

  // ── plan_tasks table: add marriage columns (idempotent) ────────────────────
  try {
    db.prepare('SELECT persistent_task_id FROM plan_tasks LIMIT 0').get();
  } catch {
    db.exec('ALTER TABLE plan_tasks ADD COLUMN persistent_task_id TEXT');
  }
  try {
    db.prepare('SELECT category_id FROM plan_tasks LIMIT 0').get();
  } catch {
    db.exec('ALTER TABLE plan_tasks ADD COLUMN category_id TEXT');
  }

  // ── phases table: add gate/required columns (idempotent) ─────────────────
  try {
    db.prepare('SELECT required FROM phases LIMIT 0').get();
  } catch {
    db.exec('ALTER TABLE phases ADD COLUMN required INTEGER NOT NULL DEFAULT 1');
  }
  try {
    db.prepare('SELECT gate FROM phases LIMIT 0').get();
  } catch {
    db.exec('ALTER TABLE phases ADD COLUMN gate INTEGER NOT NULL DEFAULT 0');
  }

  // ── plan_tasks table: add verification_strategy column (idempotent) ─────
  try {
    db.prepare('SELECT verification_strategy FROM plan_tasks LIMIT 0').get();
  } catch {
    db.exec('ALTER TABLE plan_tasks ADD COLUMN verification_strategy TEXT');
  }

  // ── plan_tasks table: CHECK constraint migration (add 'pending_audit') ──
  const tasksSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='plan_tasks'").get() as { sql: string } | undefined)?.sql ?? '';
  if (tasksSql && !tasksSql.includes("'pending_audit'")) {
    db.pragma('foreign_keys = OFF');
    db.pragma('legacy_alter_table = ON');
    db.exec('DROP TABLE IF EXISTS plan_tasks_old');
    const migrateTasks = db.transaction(() => {
      db.exec('ALTER TABLE plan_tasks RENAME TO plan_tasks_old');
      db.exec(`CREATE TABLE plan_tasks (
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
        verification_strategy TEXT,
        persistent_task_id TEXT,
        category_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        metadata TEXT,
        CONSTRAINT valid_task_status CHECK (status IN ('pending','blocked','ready','in_progress','pending_audit','completed','skipped'))
      )`);
      db.exec(`INSERT INTO plan_tasks (id, phase_id, plan_id, title, description, status, task_order,
        todo_task_id, pr_number, pr_merged, branch_name, agent_type, verification_strategy,
        persistent_task_id, category_id, created_at, updated_at, started_at, completed_at, metadata)
        SELECT id, phase_id, plan_id, title, description, status, task_order,
        todo_task_id, pr_number, pr_merged, branch_name, agent_type, verification_strategy,
        persistent_task_id, category_id, created_at, updated_at, started_at, completed_at, metadata
        FROM plan_tasks_old`);
      db.exec('DROP TABLE plan_tasks_old');
    });
    migrateTasks();
    db.pragma('legacy_alter_table = OFF');
    db.pragma('foreign_keys = ON');
  }

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
    if (task?.status === 'completed' || task?.status === 'skipped') return 100;
    if (task?.status === 'pending_audit') return 95;
    return 0;
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
          'INSERT INTO phases (id, plan_id, title, description, phase_order, status, required, gate, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(phaseId, planId, phase.title, phase.description ?? null, pi + 1, 'pending', phase.required ? 1 : 0, phase.gate ? 1 : 0, ts, ts);

        if (phase.tasks) {
          for (let ti = 0; ti < phase.tasks.length; ti++) {
            const task = phase.tasks[ti];
            const taskId = randomUUID();
            db.prepare(
              'INSERT INTO plan_tasks (id, phase_id, plan_id, title, description, status, task_order, agent_type, verification_strategy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            ).run(taskId, phaseId, planId, task.title, task.description ?? null, 'pending', ti + 1, task.agent_type ?? null, task.verification_strategy ?? null, ts, ts);

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
        category_id: task.category_id ?? null,
        verification_strategy: task.verification_strategy ?? null,
        todo_task_id: task.todo_task_id,
        persistent_task_id: task.persistent_task_id ?? null,
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
      required: !!phase.required,
      gate: !!phase.gate,
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
    persistent_task_id: plan.persistent_task_id ?? null,
    manager_agent_id: plan.manager_agent_id ?? null,
    manager_pid: plan.manager_pid ?? null,
    manager_session_id: plan.manager_session_id ?? null,
    last_heartbeat: plan.last_heartbeat ?? null,
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

  // Completion validation: require all phases to be resolved, block if any required phase is skipped without force_complete
  if (args.status === 'completed') {
    const allPhases = db.prepare('SELECT id, title, status, required FROM phases WHERE plan_id = ?')
      .all(args.plan_id) as Array<{ id: string; title: string; status: string; required: number }>;

    const incompletePhases = allPhases.filter(p => !['completed', 'skipped'].includes(p.status));
    if (incompletePhases.length > 0) {
      return {
        error: `Cannot complete plan: ${incompletePhases.length} phase(s) are still incomplete. Complete or skip remaining phases first.`,
        incomplete_phases: incompletePhases.map(p => ({ id: p.id, title: p.title, status: p.status })),
      };
    }

    const skippedRequiredPhases = allPhases.filter(p => p.status === 'skipped' && p.required);
    if (skippedRequiredPhases.length > 0 && !args.force_complete) {
      return {
        error: `Cannot complete plan: ${skippedRequiredPhases.length} required phase(s) were skipped. Use force_complete: true with a completion_note to explicitly complete.`,
        skipped_phases: skippedRequiredPhases.map(p => ({ id: p.id, title: p.title })),
      };
    }
  }

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

  recordStateChange(db, 'plan', args.plan_id, 'status', plan.status, args.status,
    args.force_complete ? 'force-complete-override' : undefined);

  // Record force_complete note in state_changes for audit trail
  if (args.force_complete && args.completion_note) {
    recordStateChange(db, 'plan', args.plan_id, 'force_complete', null, args.completion_note, 'force-complete-override');
  }

  // When activating, update task statuses
  if (args.status === 'active') {
    updateAndGetReadyTasks(db, args.plan_id);
  }

  return {
    plan_id: args.plan_id,
    old_status: plan.status,
    new_status: args.status,
    updated_at: ts,
    ...(args.force_complete ? { force_complete: true, completion_note: args.completion_note } : {}),
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
    'INSERT INTO phases (id, plan_id, title, description, phase_order, status, required, gate, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(phaseId, args.plan_id, args.title, args.description ?? null, maxOrder + 1, 'pending', args.required ? 1 : 0, args.gate ? 1 : 0, ts, ts);

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
  const values: (string | number | null)[] = [ts];

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

  if (args.required !== undefined) {
    updates.push('required = ?');
    values.push(args.required ? 1 : 0);
  }

  if (args.gate !== undefined) {
    updates.push('gate = ?');
    values.push(args.gate ? 1 : 0);
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
      'INSERT INTO plan_tasks (id, phase_id, plan_id, title, description, status, task_order, agent_type, category_id, verification_strategy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(taskId, args.phase_id, phase.plan_id, args.title, args.description ?? null, 'pending', maxOrder + 1, args.agent_type ?? null, args.category_id ?? null, args.verification_strategy ?? null, ts, ts);

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
    category_id: args.category_id ?? null,
    verification_strategy: args.verification_strategy ?? null,
    substeps_created: args.substeps?.length ?? 0,
    created_at: ts,
  };
}

/**
 * Run phase/plan auto-completion cascade after a task reaches completed/skipped.
 * Extracted as a shared helper so both updateTaskProgress and verificationAuditPass
 * can trigger the same cascade logic.
 */
function runCompletionCascade(
  db: Database.Database,
  phaseId: string,
  planId: string,
): { phaseCompleted: boolean; planCompleted: boolean; readyTasks: Array<{ id: string; title: string; agent_type: string | null }> } {
  const ts = now();
  let phaseCompleted = false;
  let planCompleted = false;

  // Phase cascade
  const phaseForCascade = db.prepare('SELECT * FROM phases WHERE id = ?').get(phaseId) as PhaseRecord;
  const allTasks = db.prepare('SELECT status FROM plan_tasks WHERE phase_id = ?').all(phaseId) as Array<{ status: string }>;
  const allTasksResolved = allTasks.every(t => t.status === 'completed' || t.status === 'skipped');

  if (allTasksResolved && phaseForCascade.status !== 'completed' && phaseForCascade.status !== 'skipped') {
    const hasAnyCompleted = allTasks.some(t => t.status === 'completed');
    if (hasAnyCompleted) {
      db.prepare("UPDATE phases SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?").run(ts, ts, phaseId);
      recordStateChange(db, 'phase', phaseId, 'status', phaseForCascade.status, 'completed');
    } else {
      db.prepare("UPDATE phases SET status = 'skipped', updated_at = ? WHERE id = ?").run(ts, phaseId);
      recordStateChange(db, 'phase', phaseId, 'status', phaseForCascade.status, 'skipped');
    }
    phaseCompleted = true;
  }

  // Update downstream tasks
  const readyTasks = updateAndGetReadyTasks(db, planId);

  // Plan cascade
  const allPhases = db.prepare('SELECT status, required FROM phases WHERE plan_id = ?').all(planId) as Array<{ status: string; required: number }>;
  const allPhasesResolved = allPhases.every(p => p.status === 'completed' || p.status === 'skipped');
  const anyRequiredSkipped = allPhases.some(p => p.status === 'skipped' && p.required);

  if (allPhasesResolved && !anyRequiredSkipped) {
    const plan = db.prepare('SELECT status FROM plans WHERE id = ?').get(planId) as { status: string };
    if (plan.status === 'active') {
      db.prepare("UPDATE plans SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?").run(ts, ts, planId);
      recordStateChange(db, 'plan', planId, 'status', 'active', 'completed');
      planCompleted = true;
    }
  }

  return { phaseCompleted, planCompleted, readyTasks };
}

function updateTaskProgress(args: UpdateTaskProgressArgs) {
  const db = getDb();
  const task = db.prepare('SELECT * FROM plan_tasks WHERE id = ?').get(args.task_id) as PlanTaskRecord | undefined;
  if (!task) return { error: `Task not found: ${args.task_id}` } as ErrorResult;

  const ts = now();
  const updates: string[] = ['updated_at = ?'];
  const values: (string | number | null)[] = [ts];

  // Track the actual status that gets written (may differ from args.status due to audit gate)
  let resolvedStatus: string | undefined;

  if (args.status) {
    // Skip guard: enforce gate phases and record skip metadata
    if (args.status === 'skipped') {
      const phase = db.prepare('SELECT gate FROM phases WHERE id = ?').get(task.phase_id) as { gate: number } | undefined;
      if (phase?.gate) {
        return { error: 'Cannot skip task: parent phase is a gate phase. Tasks in gate phases cannot be skipped.' } as ErrorResult;
      }

      // Store skip metadata on the task (merge into existing metadata)
      let existingMeta: Record<string, unknown> = {};
      try { if (task.metadata) existingMeta = JSON.parse(task.metadata); } catch { /* ignore */ }
      const mergedMeta = JSON.stringify({
        ...existingMeta,
        skip_reason: args.skip_reason,
        skip_authorization: args.skip_authorization,
        skipped_at: ts,
      });
      updates.push('metadata = ?');
      values.push(mergedMeta);
      updates.push('status = ?');
      values.push('skipped');
      resolvedStatus = 'skipped';
      recordStateChange(db, 'task', args.task_id, 'status', task.status, 'skipped', `skip:${args.skip_authorization}`);
    } else if (args.status === 'completed') {
      // Audit gate: check for verification_strategy
      if (args.force_complete) {
        // CTO bypass — complete directly
        updates.push('status = ?', 'completed_at = ?');
        values.push('completed', ts);
        resolvedStatus = 'completed';
        recordStateChange(db, 'task', args.task_id, 'status', task.status, 'completed', 'cto-force-complete');
      } else {
        const taskFull = db.prepare('SELECT verification_strategy FROM plan_tasks WHERE id = ?')
          .get(args.task_id) as { verification_strategy: string | null };

        if (taskFull.verification_strategy) {
          // Route through audit gate → pending_audit
          updates.push('status = ?');
          values.push('pending_audit');
          resolvedStatus = 'pending_audit';
          recordStateChange(db, 'task', args.task_id, 'status', task.status, 'pending_audit');

          // Create audit record
          const auditId = randomUUID();
          const attemptNum = ((db.prepare('SELECT COUNT(*) as c FROM plan_audits WHERE task_id = ?')
            .get(args.task_id) as { c: number }).c) + 1;
          db.prepare(
            'INSERT INTO plan_audits (id, task_id, plan_id, verification_strategy, requested_at, attempt_number) VALUES (?, ?, ?, ?, ?, ?)'
          ).run(auditId, args.task_id, task.plan_id, taskFull.verification_strategy, ts, attemptNum);
        } else {
          // No verification strategy — complete directly
          updates.push('status = ?', 'completed_at = ?');
          values.push('completed', ts);
          resolvedStatus = 'completed';
          recordStateChange(db, 'task', args.task_id, 'status', task.status, 'completed');
        }
      }
    } else {
      // All other status transitions (pending, blocked, ready, in_progress)
      updates.push('status = ?');
      values.push(args.status);
      resolvedStatus = args.status;
      recordStateChange(db, 'task', args.task_id, 'status', task.status, args.status);
    }

    if (args.status === 'in_progress' && !task.started_at) {
      updates.push('started_at = ?');
      values.push(ts);
    }
  }

  if (args.persistent_task_id !== undefined) {
    updates.push('persistent_task_id = ?');
    values.push(args.persistent_task_id);
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
    if (args.pr_merged && !args.status && task.status !== 'completed' && task.status !== 'pending_audit') {
      const taskFull = db.prepare('SELECT verification_strategy FROM plan_tasks WHERE id = ?')
        .get(args.task_id) as { verification_strategy: string | null };

      if (taskFull.verification_strategy) {
        updates.push('status = ?');
        values.push('pending_audit');
        resolvedStatus = 'pending_audit';
        recordStateChange(db, 'task', args.task_id, 'status', task.status, 'pending_audit');

        const auditId = randomUUID();
        const attemptNum = ((db.prepare('SELECT COUNT(*) as c FROM plan_audits WHERE task_id = ?')
          .get(args.task_id) as { c: number }).c) + 1;
        db.prepare(
          'INSERT INTO plan_audits (id, task_id, plan_id, verification_strategy, requested_at, attempt_number) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(auditId, args.task_id, task.plan_id, taskFull.verification_strategy, ts, attemptNum);
      } else {
        updates.push('status = ?');
        values.push('completed');
        updates.push('completed_at = ?');
        values.push(ts);
        resolvedStatus = 'completed';
        recordStateChange(db, 'task', args.task_id, 'status', task.status, 'completed');
      }
    }
  }

  db.prepare(`UPDATE plan_tasks SET ${updates.join(', ')} WHERE id = ?`).run(...values, args.task_id);

  // Run completion cascade (pending_audit naturally blocks it — not completed or skipped)
  const cascade = runCompletionCascade(db, task.phase_id, task.plan_id);

  return {
    task_id: args.task_id,
    status: resolvedStatus ?? task.status,
    verification_strategy: (db.prepare('SELECT verification_strategy FROM plan_tasks WHERE id = ?')
      .get(args.task_id) as { verification_strategy: string | null })?.verification_strategy ?? null,
    updated_at: ts,
    progress_pct: getTaskProgress(db, args.task_id),
    newly_ready: cascade.readyTasks.map(t => ({ id: t.id, title: t.title, agent_type: t.agent_type })),
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

function planSessions(args: PlanSessionsArgs) {
  // Step 1: Collect plan tasks with todo_task_id from plans.db
  const db = getDb();

  let tasksQuery: PlanTaskRecord[];
  if (args.plan_id) {
    const plan = db.prepare('SELECT id, title FROM plans WHERE id = ?').get(args.plan_id) as { id: string; title: string } | undefined;
    if (!plan) return { error: `Plan not found: ${args.plan_id}` } as ErrorResult;
    tasksQuery = db.prepare(
      "SELECT * FROM plan_tasks WHERE plan_id = ? AND todo_task_id IS NOT NULL"
    ).all(args.plan_id) as PlanTaskRecord[];
  } else {
    tasksQuery = db.prepare(
      `SELECT pt.* FROM plan_tasks pt
       JOIN plans p ON pt.plan_id = p.id
       WHERE pt.todo_task_id IS NOT NULL
         AND p.status IN ('draft', 'active', 'paused')`
    ).all() as PlanTaskRecord[];
  }

  if (tasksQuery.length === 0) {
    return { sessions: 'No plan tasks with todo_task_id links found.' };
  }

  const todoTaskToPlantTask = new Map<string, { planTaskId: string; planTaskTitle: string }>(
    tasksQuery.map((t) => [t.todo_task_id!, { planTaskId: t.id, planTaskTitle: t.title }])
  );

  // Step 2: Read agent-tracker-history.json
  let allAgentHistory: Array<{
    id: string; type: string; pid?: number | null;
    timestamp: string; reapedAt?: string | null; status?: string;
    metadata?: { taskId?: string; resumedAgentId?: string; [key: string]: unknown };
  }> = [];

  try {
    const historyPath = path.join(PROJECT_DIR, '.claude', 'state', 'agent-tracker-history.json');
    if (fs.existsSync(historyPath)) {
      const raw = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
      if (Array.isArray(raw)) allAgentHistory = raw;
    }
  } catch {
    // unavailable
  }

  const since = Date.now() - args.hours * 60 * 60 * 1000;
  const matchedAgents = allAgentHistory.filter(
    (a) => a.metadata?.taskId && todoTaskToPlantTask.has(a.metadata.taskId)
      && new Date(a.timestamp).getTime() >= since
  );

  if (matchedAgents.length === 0) {
    return { sessions: 'No agents found correlated to plan tasks. Agents must be linked via metadata.taskId.' };
  }

  // Step 3: Build session info for each matched agent
  interface SessionEvent {
    timestamp: string;
    label: string;
    detail?: string;
  }

  interface SessionInfo {
    agentId: string;
    agentType: string;
    pid: number | null;
    planTaskTitle: string;
    planTaskId: string;
    todoTaskId: string;
    status: string;
    spawnedAt: string;
    reapedAt: string | null;
    tokensTotal: number;
    isRevived: boolean;
    events: SessionEvent[];
  }

  const sessions: SessionInfo[] = matchedAgents.map((agent) => {
    const todoTaskId = agent.metadata!.taskId as string;
    const planInfo = todoTaskToPlantTask.get(todoTaskId)!;
    const agentStatus = (() => {
      if (!agent.reapedAt) return 'running';
      const s = agent.status?.toLowerCase() ?? '';
      if (s === 'completed' || s === 'success') return 'completed';
      if (s === 'interrupted') return 'interrupted';
      if (s === 'paused') return 'paused';
      return 'completed';
    })();

    return {
      agentId: agent.id,
      agentType: agent.type,
      pid: agent.pid ?? null,
      planTaskTitle: planInfo.planTaskTitle,
      planTaskId: planInfo.planTaskId,
      todoTaskId,
      status: agentStatus,
      spawnedAt: agent.timestamp,
      reapedAt: agent.reapedAt ?? null,
      tokensTotal: 0,
      isRevived: false,
      events: [{
        timestamp: agent.timestamp,
        label: `Session Spawned (${agent.type}, PID ${agent.pid ?? 'unknown'})`,
      }],
    };
  });

  const sessionById = new Map<string, SessionInfo>(sessions.map((s) => [s.agentId, s]));
  const sessionByTodoTaskId = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    const arr = sessionByTodoTaskId.get(s.todoTaskId) ?? [];
    arr.push(s);
    sessionByTodoTaskId.set(s.todoTaskId, arr);
  }
  const agentById = new Map(matchedAgents.map((a) => [a.id, a]));

  // Step 4: Quota-interrupted sessions
  try {
    const quotaPath = path.join(PROJECT_DIR, '.claude', 'state', 'quota-interrupted-sessions.json');
    if (fs.existsSync(quotaPath)) {
      const entries: Array<{ agentId?: string; interrupted_at?: string; reason?: string }> =
        JSON.parse(fs.readFileSync(quotaPath, 'utf8'));
      for (const entry of (Array.isArray(entries) ? entries : [])) {
        if (!entry.agentId) continue;
        const session = sessionById.get(entry.agentId);
        if (!session) continue;
        const agent = agentById.get(entry.agentId);
        const ts = entry.interrupted_at ?? agent?.reapedAt ?? new Date().toISOString();
        session.events.push({ timestamp: ts, label: `Quota Interrupt (${entry.reason ?? 'quota exhausted'})` });
        session.events.push({ timestamp: ts, label: 'Session Interrupted' });
        if (session.status === 'running') session.status = 'interrupted';
      }
    }
  } catch { /* non-fatal */ }

  // Step 5: Paused sessions
  try {
    const pausedPath = path.join(PROJECT_DIR, '.claude', 'state', 'paused-sessions.json');
    if (fs.existsSync(pausedPath)) {
      const entries: Array<{ agentId?: string; paused_at?: string }> =
        JSON.parse(fs.readFileSync(pausedPath, 'utf8'));
      for (const entry of (Array.isArray(entries) ? entries : [])) {
        if (!entry.agentId) continue;
        const session = sessionById.get(entry.agentId);
        if (!session) continue;
        const ts = entry.paused_at ?? new Date().toISOString();
        session.events.push({ timestamp: ts, label: 'Session Paused' });
        if (session.status === 'running') session.status = 'paused';
      }
    }
  } catch { /* non-fatal */ }

  // Step 6: Revival agents
  try {
    for (const revivalAgent of allAgentHistory) {
      if (revivalAgent.type !== 'session-revived') continue;
      const resumedId = revivalAgent.metadata?.resumedAgentId as string | undefined;
      if (!resumedId) continue;
      const originalSession = sessionById.get(resumedId);
      if (!originalSession) continue;
      originalSession.isRevived = true;
      originalSession.events.push({
        timestamp: revivalAgent.timestamp,
        label: `Session Revived (by ${revivalAgent.id})`,
      });
    }
  } catch { /* non-fatal */ }

  // Step 7: Worklog entries
  try {
    if (fs.existsSync(WORKLOG_DB_PATH)) {
      const wdb = new Database(WORKLOG_DB_PATH, { readonly: true });
      try {
        const todoTaskIds = Array.from(sessionByTodoTaskId.keys());
        if (todoTaskIds.length > 0) {
          const placeholders = todoTaskIds.map(() => '?').join(',');
          const rows = wdb.prepare(
            `SELECT task_id, tokens_total, created_at, outcome FROM worklog_entries WHERE task_id IN (${placeholders}) ORDER BY created_at ASC`
          ).all(...todoTaskIds) as Array<{ task_id: string; tokens_total: number; created_at: string; outcome: string | null }>;

          for (const row of rows) {
            const relatedSessions = sessionByTodoTaskId.get(row.task_id) ?? [];
            const session = relatedSessions[relatedSessions.length - 1];
            if (!session) continue;
            session.tokensTotal += row.tokens_total ?? 0;
            session.events.push({
              timestamp: row.created_at,
              label: `Worklog Entry (${row.outcome ?? formatTokens(row.tokens_total ?? 0) + ' tokens'})`,
            });
          }
        }
      } finally {
        try { wdb.close(); } catch { /* ignore */ }
      }
    }
  } catch { /* non-fatal */ }

  // Step 8: State changes from plans.db — route events to correct session by timestamp window
  try {
    const processedPlanTaskIds = new Set<string>();
    for (const session of sessions) {
      if (processedPlanTaskIds.has(session.planTaskId)) continue;
      processedPlanTaskIds.add(session.planTaskId);

      const substepIds = (
        db.prepare('SELECT id FROM substeps WHERE task_id = ?').all(session.planTaskId) as Array<{ id: string }>
      ).map((r) => r.id);

      const entityIds = [session.planTaskId, ...substepIds];

      const placeholders = entityIds.map(() => '?').join(',');
      const changes = db.prepare(
        `SELECT entity_type, entity_id, field_name, old_value, new_value, changed_at
         FROM state_changes WHERE entity_id IN (${placeholders}) ORDER BY changed_at ASC`
      ).all(...entityIds) as StateChangeRecord[];

      // Get all sessions for this plan task
      const relatedSessions = sessionByTodoTaskId.get(session.todoTaskId) ?? [session];

      for (const change of changes) {
        // Route to correct session by timestamp window
        const changeMs = new Date(change.changed_at).getTime();
        let target: SessionInfo | undefined;
        for (const s of relatedSessions) {
          const spawnMs = new Date(s.spawnedAt).getTime();
          const endMs = s.reapedAt ? new Date(s.reapedAt).getTime() : Date.now();
          if (changeMs >= spawnMs && changeMs <= endMs) { target = s; break; }
        }
        if (!target) target = relatedSessions[relatedSessions.length - 1];

        if (change.entity_type === 'substep' && change.field_name === 'completed' && change.new_value === '1') {
          const substepRow = db.prepare('SELECT title FROM substeps WHERE id = ?').get(change.entity_id) as { title: string } | undefined;
          target.events.push({
            timestamp: change.changed_at,
            label: `Substep Completed (${substepRow?.title ?? change.entity_id.substring(0, 8)})`,
          });
        } else if (change.entity_type === 'task' && change.field_name === 'status') {
          if (change.new_value === 'completed') {
            target.events.push({ timestamp: change.changed_at, label: 'Plan Task Completed' });
          } else {
            target.events.push({
              timestamp: change.changed_at,
              label: `Task Status Changed (${change.old_value ?? '?'} → ${change.new_value ?? '?'})`,
            });
          }
        } else if (change.entity_type === 'task' && change.field_name === 'pr_number' && change.new_value) {
          target.events.push({
            timestamp: change.changed_at,
            label: `PR #${change.new_value} Created`,
          });
        } else if (change.entity_type === 'task' && change.field_name === 'pr_merged' && change.new_value === '1') {
          const taskRow = db.prepare('SELECT pr_number FROM plan_tasks WHERE id = ?').get(change.entity_id) as { pr_number: number | null } | undefined;
          const prNum = taskRow?.pr_number;
          target.events.push({
            timestamp: change.changed_at,
            label: prNum ? `PR #${prNum} Merged` : 'PR Merged',
          });
        }
      }
    }
  } catch { /* non-fatal */ }

  // Step 9: Sort events, build output
  const now = Date.now();
  const lines: string[] = [];

  let runningCount = 0;
  let completedCount = 0;
  let interruptedCount = 0;
  let revivedCount = 0;
  let totalTokens = 0;

  for (const session of sessions) {
    session.events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const startMs = new Date(session.spawnedAt).getTime();
    const endMs = session.reapedAt ? new Date(session.reapedAt).getTime() : now;
    const durationMs = Math.max(0, endMs - startMs);
    const durationStr = formatDuration(durationMs);
    const titleTrunc = session.planTaskTitle.length > 30
      ? session.planTaskTitle.substring(0, 27) + '...'
      : session.planTaskTitle;

    if (session.status === 'running') {
      lines.push(`SESSION: ${session.agentId} | Task: "${titleTrunc}" | RUNNING (${durationStr})`);
      runningCount++;
    } else {
      const tokenStr = session.tokensTotal > 0 ? ` | ${formatTokens(session.tokensTotal)} tokens` : '';
      lines.push(`SESSION: ${session.agentId} | Task: "${titleTrunc}" | ${durationStr}${tokenStr}`);
      if (session.status === 'completed') completedCount++;
      else if (session.status === 'interrupted' || session.status === 'paused') interruptedCount++;
    }

    for (const event of session.events) {
      const time = formatCompactTime(event.timestamp);
      const detail = event.detail ? ` (${event.detail})` : '';
      lines.push(`  ${time}  → ${event.label}${detail}`);
    }

    if (session.status === 'running') {
      lines.push('  ...currently running...');
    }

    if (session.isRevived) revivedCount++;
    totalTokens += session.tokensTotal;

    lines.push('');
  }

  const tokenStr = formatTokens(totalTokens);
  const parts = [
    `${sessions.length} session${sessions.length !== 1 ? 's' : ''}`,
    `${runningCount} running`,
    `${completedCount} completed`,
  ];
  if (interruptedCount > 0) parts.push(`${interruptedCount} interrupted`);
  parts.push(`${revivedCount} revived`, `${tokenStr} tokens`);
  lines.push(`Summary: ${parts.join(' | ')}`);

  return { sessions: lines.join('\n') };
}

// ============================================================================
// Verification Audit Tools
// ============================================================================

function checkVerificationAudit(args: CheckVerificationAuditArgs) {
  const db = getDb();
  const audit = db.prepare(
    'SELECT * FROM plan_audits WHERE task_id = ? ORDER BY attempt_number DESC LIMIT 1'
  ).get(args.task_id) as PlanAuditRecord | undefined;

  if (!audit) {
    return { task_id: args.task_id, status: 'no_audit_pending' };
  }

  return {
    task_id: args.task_id,
    audit_id: audit.id,
    verdict: audit.verdict,
    status: audit.verdict === null ? 'pending_audit' : audit.verdict === 'pass' ? 'completed' : 'audit_failed',
    evidence: audit.evidence,
    failure_reason: audit.failure_reason,
    verification_strategy: audit.verification_strategy,
    attempt_number: audit.attempt_number,
    requested_at: audit.requested_at,
    completed_at: audit.completed_at,
  };
}

function verificationAuditPass(args: VerificationAuditPassArgs) {
  const db = getDb();
  const ts = now();

  // Find pending audit for this task
  const audit = db.prepare(
    "SELECT * FROM plan_audits WHERE task_id = ? AND verdict IS NULL ORDER BY attempt_number DESC LIMIT 1"
  ).get(args.task_id) as PlanAuditRecord | undefined;

  if (!audit) {
    return { error: `No pending audit found for task: ${args.task_id}` } as ErrorResult;
  }

  // Verify task is still in pending_audit
  const task = db.prepare('SELECT * FROM plan_tasks WHERE id = ?').get(args.task_id) as PlanTaskRecord | undefined;
  if (!task) return { error: `Task not found: ${args.task_id}` } as ErrorResult;
  if (task.status !== 'pending_audit') {
    return { error: `Task is not in pending_audit status (current: ${task.status})` } as ErrorResult;
  }

  const passTx = db.transaction(() => {
    // Record verdict
    db.prepare(
      'UPDATE plan_audits SET verdict = ?, evidence = ?, completed_at = ? WHERE id = ?'
    ).run('pass', args.evidence, ts, audit.id);

    // Transition task to completed
    db.prepare(
      "UPDATE plan_tasks SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?"
    ).run(ts, ts, args.task_id);

    recordStateChange(db, 'task', args.task_id, 'status', 'pending_audit', 'completed', 'plan-auditor');
  });
  passTx();

  // Run completion cascade (phase/plan auto-complete)
  const cascade = runCompletionCascade(db, task.phase_id, task.plan_id);

  return {
    task_id: args.task_id,
    verdict: 'pass',
    completed_at: ts,
    attempt_number: audit.attempt_number,
    phase_completed: cascade.phaseCompleted,
    plan_completed: cascade.planCompleted,
    newly_ready: cascade.readyTasks.map(t => ({ id: t.id, title: t.title, agent_type: t.agent_type })),
  };
}

function verificationAuditFail(args: VerificationAuditFailArgs) {
  const db = getDb();
  const ts = now();

  // Find pending audit for this task
  const audit = db.prepare(
    "SELECT * FROM plan_audits WHERE task_id = ? AND verdict IS NULL ORDER BY attempt_number DESC LIMIT 1"
  ).get(args.task_id) as PlanAuditRecord | undefined;

  if (!audit) {
    return { error: `No pending audit found for task: ${args.task_id}` } as ErrorResult;
  }

  // Verify task is still in pending_audit
  const task = db.prepare('SELECT * FROM plan_tasks WHERE id = ?').get(args.task_id) as PlanTaskRecord | undefined;
  if (!task) return { error: `Task not found: ${args.task_id}` } as ErrorResult;
  if (task.status !== 'pending_audit') {
    return { error: `Task is not in pending_audit status (current: ${task.status})` } as ErrorResult;
  }

  const failTx = db.transaction(() => {
    // Record verdict
    db.prepare(
      'UPDATE plan_audits SET verdict = ?, failure_reason = ?, evidence = ?, completed_at = ? WHERE id = ?'
    ).run('fail', args.failure_reason, args.evidence ?? null, ts, audit.id);

    // Transition task back to in_progress
    db.prepare(
      "UPDATE plan_tasks SET status = 'in_progress', completed_at = NULL, updated_at = ? WHERE id = ?"
    ).run(ts, args.task_id);

    recordStateChange(db, 'task', args.task_id, 'status', 'pending_audit', 'in_progress', 'plan-auditor-fail');
  });
  failTx();

  return {
    task_id: args.task_id,
    verdict: 'fail',
    failure_reason: args.failure_reason,
    attempt_number: audit.attempt_number,
  };
}

function forceClosePlan(args: ForceClosePlanArgs): object {
  const db = getDb();

  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(args.plan_id) as PlanRecord | undefined;
  if (!plan) {
    return { error: `Plan not found: ${args.plan_id}` };
  }

  if (plan.status === 'completed' || plan.status === 'archived') {
    return { error: `Plan is already ${plan.status}` };
  }

  const ts = now();

  // Cancel the plan
  const oldStatus = plan.status;
  db.prepare("UPDATE plans SET status = 'cancelled', completed_at = ?, updated_at = ? WHERE id = ?")
    .run(ts, ts, args.plan_id);
  recordStateChange(db, 'plan', args.plan_id, 'status', oldStatus, 'cancelled', 'cto-force-close');

  // Collect persistent task IDs from plan tasks for caller to cancel
  const linkedPersistentTasks = db.prepare(
    'SELECT persistent_task_id FROM plan_tasks WHERE plan_id = ? AND persistent_task_id IS NOT NULL'
  ).all(args.plan_id) as Array<{ persistent_task_id: string }>;

  return {
    plan_id: args.plan_id,
    status: 'cancelled',
    reason: args.reason,
    cancelled_at: ts,
    persistent_tasks_to_cancel: linkedPersistentTasks.map(t => t.persistent_task_id),
    message: `Plan force-closed. ${linkedPersistentTasks.length} linked persistent task(s) should be cancelled via cancel_persistent_task.`,
  };
}

// ============================================================================
// Plan Blocking Status
// ============================================================================

async function getPlanBlockingStatus(args: GetPlanBlockingStatusArgs): Promise<string> {
  const db = getDb();

  // Get plan
  const plan = db.prepare('SELECT id, title, status FROM plans WHERE id = ?').get(args.plan_id) as { id: string; title: string; status: string } | undefined;
  if (!plan) return JSON.stringify({ error: 'Plan not found' });

  // Get paused plan tasks
  const pausedTasks = db.prepare(
    "SELECT id, title, phase_id, persistent_task_id, metadata FROM plan_tasks WHERE plan_id = ? AND status = 'paused'"
  ).all(args.plan_id) as Array<{ id: string; title: string; phase_id: string; persistent_task_id: string | null; metadata: string | null }>;

  // Get available parallel work (in_progress or ready tasks)
  const parallelWork = db.prepare(
    "SELECT id, title, status, phase_id FROM plan_tasks WHERE plan_id = ? AND status IN ('in_progress', 'ready')"
  ).all(args.plan_id) as Array<{ id: string; title: string; status: string; phase_id: string }>;

  // For each paused task, find downstream blocked tasks
  const blockedDownstream: Array<{ task_id: string; title: string; blocked_by: string }> = [];
  for (const pt of pausedTasks) {
    const downstream = db.prepare(
      "SELECT pt.id, pt.title FROM dependencies d JOIN plan_tasks pt ON d.blocked_id = pt.id AND d.blocked_type = 'task' WHERE d.blocker_id = ? AND d.blocker_type = 'task'"
    ).all(pt.id) as Array<{ id: string; title: string }>;
    for (const d of downstream) {
      blockedDownstream.push({ task_id: d.id, title: d.title, blocked_by: pt.id });
    }
  }

  // Check if any paused task is in a gate phase
  const gatePhaseIds = new Set<string>();
  for (const pt of pausedTasks) {
    const phase = db.prepare('SELECT gate FROM phases WHERE id = ?').get(pt.phase_id) as { gate: number } | undefined;
    if (phase?.gate) gatePhaseIds.add(pt.phase_id);
  }

  const fullyBlocked = pausedTasks.length > 0 && parallelWork.length === 0;
  const partiallyBlocked = pausedTasks.length > 0 && parallelWork.length > 0;

  // Build recommended actions
  const recommendedActions: string[] = [];
  if (fullyBlocked) {
    recommendedActions.push('Plan is fully blocked. Submit bypass request if not already done.');
    recommendedActions.push('Wait for CTO to resolve blocking items.');
  } else if (partiallyBlocked) {
    recommendedActions.push(`${parallelWork.length} task(s) available for parallel work.`);
    recommendedActions.push('Continue spawning unblocked tasks while waiting for resolution.');
  }
  if (gatePhaseIds.size > 0) {
    recommendedActions.push(`${gatePhaseIds.size} gate phase(s) affected — plan cannot complete until resolved.`);
  }

  return JSON.stringify({
    plan_id: plan.id,
    plan_title: plan.title,
    plan_status: plan.status,
    fully_blocked: fullyBlocked,
    partially_blocked: partiallyBlocked,
    paused_tasks: pausedTasks.map(t => ({
      id: t.id,
      title: t.title,
      persistent_task_id: t.persistent_task_id,
      in_gate_phase: gatePhaseIds.has(t.phase_id),
    })),
    blocked_downstream: blockedDownstream,
    available_parallel_work: parallelWork.map(t => ({
      id: t.id,
      title: t.title,
      status: t.status,
    })),
    gate_phases_affected: gatePhaseIds.size,
    recommended_actions: recommendedActions,
  });
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
    description: 'Update plan status. Completing requires all phases completed; if any phase was skipped, requires force_complete: true with completion_note. Activating updates task readiness.',
    schema: UpdatePlanStatusArgsSchema,
    handler: updatePlanStatus,
  },
  {
    name: 'add_phase',
    description: 'Add a phase to an existing plan. Auto-assigns order. Set gate: true for verification phases whose tasks cannot be skipped. Set required: false for optional phases that do not block plan completion.',
    schema: AddPhaseArgsSchema,
    handler: addPhase,
  },
  {
    name: 'update_phase',
    description: 'Update phase title, status, required, or gate flags. Status changes are recorded in state_changes.',
    schema: UpdatePhaseArgsSchema,
    handler: updatePhase,
  },
  {
    name: 'add_plan_task',
    description: 'Add a task to a phase. Set verification_strategy to require independent auditor approval before completion. Optionally create a linked todo-db task and add inline substeps.',
    schema: AddPlanTaskArgsSchema,
    handler: addPlanTask,
  },
  {
    name: 'update_task_progress',
    description: 'Update task status, PR info, or branch. Tasks with verification_strategy enter pending_audit instead of completed (auditor must pass them). Use force_complete: true for CTO bypass. Auto-completes on pr_merged=true. Returns newly ready tasks. Setting status to "skipped" requires skip_reason and skip_authorization fields. Tasks in gate phases cannot be skipped.',
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
  {
    name: 'plan_sessions',
    description: 'Per-session lifecycle timeline showing spawns, rotations, interrupts, revivals, worklogs, and PR merges for plan task agents.',
    schema: PlanSessionsArgsSchema,
    handler: planSessions,
  },
  {
    name: 'force_close_plan',
    description: 'Force-close a plan and cancel all running work. WARNING: Only use when directly asked by the CTO. Returns persistent task IDs that must be separately cancelled via cancel_persistent_task.',
    schema: ForceClosePlanArgsSchema,
    handler: forceClosePlan,
  },
  {
    name: 'check_verification_audit',
    description: 'Check audit status for a plan task. Returns verdict (pass/fail/pending) and evidence. Use to poll auditor progress after a task enters pending_audit.',
    schema: CheckVerificationAuditArgsSchema,
    handler: checkVerificationAudit,
  },
  {
    name: 'verification_audit_pass',
    description: 'Mark a plan task audit as PASSED. Only called by independent auditor agents. Transitions task from pending_audit to completed and runs phase/plan completion cascade.',
    schema: VerificationAuditPassArgsSchema,
    handler: verificationAuditPass,
  },
  {
    name: 'verification_audit_fail',
    description: 'Mark a plan task audit as FAILED. Only called by independent auditor agents. Transitions task from pending_audit back to in_progress so the plan manager can investigate and retry.',
    schema: VerificationAuditFailArgsSchema,
    handler: verificationAuditFail,
  },
  {
    name: 'get_plan_blocking_status',
    description: 'Check whether a plan is blocked by paused tasks. Returns blocking assessment including paused tasks, downstream impact, and available parallel work. Used by plan-manager agents to assess blocking state on each monitoring cycle.',
    schema: GetPlanBlockingStatusArgsSchema,
    handler: getPlanBlockingStatus,
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
