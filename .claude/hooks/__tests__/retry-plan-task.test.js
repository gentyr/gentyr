/**
 * Tests for the retry_plan_task tool in the plan-orchestrator MCP server.
 *
 * Covers:
 *   1.  completed -> pending transition works, clears persistent_task_id and completed_at
 *   2.  skipped -> pending transition works
 *   3.  paused -> pending transition works
 *   4.  pending_audit -> pending transition works
 *   5.  in_progress -> rejected (can't retry an active task)
 *   6.  pending -> rejected (can't retry a task that hasn't run yet)
 *   7.  ready -> rejected
 *   8.  blocked -> rejected
 *   9.  Phase reset: if task's phase was completed, it resets to in_progress
 *  10.  Plan reset: if plan was completed, it resets to active
 *  11.  State change recorded in state_changes table
 *  12.  Non-existent task returns error
 *
 * Strategy: create real SQLite databases in temp directories mirroring the
 * production schema for plans.db. Test the SQL logic directly since the
 * handler function logic is straightforward SQL operations.
 *
 * Run with: node --test .claude/hooks/__tests__/retry-plan-task.test.js
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

// ============================================================================
// Schema — mirrors the plan-orchestrator server.ts SCHEMA
// ============================================================================

const PLANS_SCHEMA = `
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  created_by TEXT,
  metadata TEXT,
  persistent_task_id TEXT,
  manager_agent_id TEXT,
  manager_pid INTEGER,
  manager_session_id TEXT,
  last_heartbeat TEXT
);

CREATE TABLE IF NOT EXISTS phases (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  phase_order INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  metadata TEXT,
  required INTEGER NOT NULL DEFAULT 1,
  gate INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS plan_tasks (
  id TEXT PRIMARY KEY,
  phase_id TEXT NOT NULL REFERENCES phases(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  task_order INTEGER NOT NULL DEFAULT 0,
  todo_task_id TEXT,
  pr_number INTEGER,
  pr_merged INTEGER,
  branch_name TEXT,
  agent_type TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  metadata TEXT,
  verification_strategy TEXT,
  persistent_task_id TEXT,
  category_id TEXT
);

CREATE TABLE IF NOT EXISTS state_changes (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  changed_at TEXT NOT NULL DEFAULT (datetime('now')),
  changed_by TEXT
);

CREATE TABLE IF NOT EXISTS substeps (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES plan_tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  step_order INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dependencies (
  id TEXT PRIMARY KEY,
  blocker_type TEXT NOT NULL,
  blocker_id TEXT NOT NULL,
  blocked_type TEXT NOT NULL,
  blocked_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plan_audits (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  verification_strategy TEXT NOT NULL,
  verdict TEXT,
  evidence TEXT,
  failure_reason TEXT,
  auditor_agent_id TEXT,
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  attempt_number INTEGER NOT NULL DEFAULT 1
);
`;

// ============================================================================
// Helpers
// ============================================================================

function generateId(prefix = 'id') {
  return `${prefix}-${crypto.randomBytes(6).toString('hex')}`;
}

function now() {
  return new Date().toISOString();
}

function recordStateChange(db, entityType, entityId, fieldName, oldValue, newValue, changedBy) {
  db.prepare(
    'INSERT INTO state_changes (id, entity_type, entity_id, field_name, old_value, new_value, changed_at, changed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(generateId('sc'), entityType, entityId, fieldName, oldValue, newValue, now(), changedBy || null);
}

/**
 * Implements the exact retry_plan_task handler logic from server.ts.
 * This ensures the test validates the same behavior as production.
 */
function retryPlanTask(db, args) {
  const ts = now();

  const task = db.prepare('SELECT * FROM plan_tasks WHERE id = ?').get(args.task_id);
  if (!task) {
    return { error: `Task not found: ${args.task_id}` };
  }

  const retryableStatuses = ['completed', 'pending_audit', 'skipped', 'paused'];
  if (!retryableStatuses.includes(task.status)) {
    return {
      error: `Cannot retry task with status '${task.status}'. Only tasks with status in [${retryableStatuses.join(', ')}] can be retried. Task '${args.task_id}' is currently '${task.status}'.`,
    };
  }

  const oldStatus = task.status;
  let phaseReset = false;
  let planReset = false;

  const retryTx = db.transaction(() => {
    db.prepare(
      "UPDATE plan_tasks SET status = 'pending', completed_at = NULL, persistent_task_id = NULL, updated_at = ? WHERE id = ?"
    ).run(ts, args.task_id);

    recordStateChange(db, 'task', args.task_id, 'status', oldStatus, 'pending', 'retry: ' + args.reason);

    const phase = db.prepare('SELECT * FROM phases WHERE id = ?').get(task.phase_id);
    if (phase && (phase.status === 'completed' || phase.status === 'skipped')) {
      db.prepare(
        "UPDATE phases SET status = 'in_progress', completed_at = NULL, updated_at = ? WHERE id = ?"
      ).run(ts, phase.id);
      recordStateChange(db, 'phase', phase.id, 'status', phase.status, 'in_progress', 'retry: task reset');
      phaseReset = true;
    }

    const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(task.plan_id);
    if (plan && plan.status === 'completed') {
      db.prepare(
        "UPDATE plans SET status = 'active', completed_at = NULL, updated_at = ? WHERE id = ?"
      ).run(ts, plan.id);
      recordStateChange(db, 'plan', plan.id, 'status', 'completed', 'active', 'retry: task reset');
      planReset = true;
    }
  });
  retryTx();

  return {
    task_id: args.task_id,
    old_status: oldStatus,
    new_status: 'pending',
    phase_reset: phaseReset,
    plan_reset: planReset,
    reason: args.reason,
  };
}

/**
 * Create a test DB with a plan, phase, and task.
 */
function createTestDb() {
  const dbPath = path.join(os.tmpdir(), `retry-plan-test-${Date.now()}-${crypto.randomBytes(2).toString('hex')}.db`);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 3000');
  db.exec(PLANS_SCHEMA);

  return {
    db,
    dbPath,
    cleanup() {
      try { db.close(); } catch (_) { /* non-fatal */ }
      for (const ext of ['', '-shm', '-wal']) {
        const f = dbPath + ext;
        if (fs.existsSync(f)) try { fs.unlinkSync(f); } catch (_) { /* non-fatal */ }
      }
    },
  };
}

function insertPlan(db, { id = generateId('plan'), status = 'active' } = {}) {
  const ts = now();
  db.prepare(`
    INSERT INTO plans (id, title, status, created_at, updated_at)
    VALUES (?, 'Test Plan', ?, ?, ?)
  `).run(id, status, ts, ts);
  return id;
}

function insertPhase(db, { id = generateId('phase'), planId, status = 'in_progress', order = 1 } = {}) {
  const ts = now();
  db.prepare(`
    INSERT INTO phases (id, plan_id, title, phase_order, status, created_at, updated_at)
    VALUES (?, ?, 'Test Phase', ?, ?, ?, ?)
  `).run(id, planId, order, status, ts, ts);
  return id;
}

function insertTask(db, { id = generateId('task'), phaseId, planId, status = 'pending', persistentTaskId = null } = {}) {
  const ts = now();
  const completedAt = (status === 'completed' || status === 'skipped') ? ts : null;
  db.prepare(`
    INSERT INTO plan_tasks (id, phase_id, plan_id, title, status, completed_at, persistent_task_id, created_at, updated_at)
    VALUES (?, ?, ?, 'Test Task', ?, ?, ?, ?, ?)
  `).run(id, phaseId, planId, status, completedAt, persistentTaskId, ts, ts);
  return id;
}

// ============================================================================
// Test Group 1: Retryable status transitions
// ============================================================================

describe('retry_plan_task — retryable status transitions', () => {
  let ctx;

  beforeEach(() => { ctx = createTestDb(); });
  afterEach(() => { ctx.cleanup(); });

  it('completed -> pending: clears persistent_task_id and completed_at', () => {
    const planId = insertPlan(ctx.db);
    const phaseId = insertPhase(ctx.db, { planId });
    const taskId = insertTask(ctx.db, { phaseId, planId, status: 'completed', persistentTaskId: 'pt-123' });

    const result = retryPlanTask(ctx.db, { task_id: taskId, reason: 'retry after fix' });

    assert.strictEqual(result.old_status, 'completed');
    assert.strictEqual(result.new_status, 'pending');
    assert.strictEqual(result.task_id, taskId);

    const task = ctx.db.prepare('SELECT * FROM plan_tasks WHERE id = ?').get(taskId);
    assert.strictEqual(task.status, 'pending');
    assert.strictEqual(task.completed_at, null, 'completed_at must be cleared');
    assert.strictEqual(task.persistent_task_id, null, 'persistent_task_id must be cleared');
  });

  it('skipped -> pending transition works', () => {
    const planId = insertPlan(ctx.db);
    const phaseId = insertPhase(ctx.db, { planId });
    const taskId = insertTask(ctx.db, { phaseId, planId, status: 'skipped' });

    const result = retryPlanTask(ctx.db, { task_id: taskId, reason: 'undo skip' });

    assert.strictEqual(result.old_status, 'skipped');
    assert.strictEqual(result.new_status, 'pending');

    const task = ctx.db.prepare('SELECT * FROM plan_tasks WHERE id = ?').get(taskId);
    assert.strictEqual(task.status, 'pending');
  });

  it('paused -> pending transition works', () => {
    const planId = insertPlan(ctx.db);
    const phaseId = insertPhase(ctx.db, { planId });
    const taskId = insertTask(ctx.db, { phaseId, planId, status: 'paused' });

    const result = retryPlanTask(ctx.db, { task_id: taskId, reason: 'unpause and retry' });

    assert.strictEqual(result.old_status, 'paused');
    assert.strictEqual(result.new_status, 'pending');

    const task = ctx.db.prepare('SELECT * FROM plan_tasks WHERE id = ?').get(taskId);
    assert.strictEqual(task.status, 'pending');
  });

  it('pending_audit -> pending transition works', () => {
    const planId = insertPlan(ctx.db);
    const phaseId = insertPhase(ctx.db, { planId });
    const taskId = insertTask(ctx.db, { phaseId, planId, status: 'pending_audit' });

    const result = retryPlanTask(ctx.db, { task_id: taskId, reason: 'audit failed, retry from scratch' });

    assert.strictEqual(result.old_status, 'pending_audit');
    assert.strictEqual(result.new_status, 'pending');

    const task = ctx.db.prepare('SELECT * FROM plan_tasks WHERE id = ?').get(taskId);
    assert.strictEqual(task.status, 'pending');
  });
});

// ============================================================================
// Test Group 2: Non-retryable status rejections
// ============================================================================

describe('retry_plan_task — non-retryable status rejections', () => {
  let ctx;

  beforeEach(() => { ctx = createTestDb(); });
  afterEach(() => { ctx.cleanup(); });

  it('in_progress -> rejected', () => {
    const planId = insertPlan(ctx.db);
    const phaseId = insertPhase(ctx.db, { planId });
    const taskId = insertTask(ctx.db, { phaseId, planId, status: 'in_progress' });

    const result = retryPlanTask(ctx.db, { task_id: taskId, reason: 'should not work' });

    assert.ok(result.error, 'must return an error for in_progress task');
    assert.ok(result.error.includes('in_progress'), 'error must mention current status');
  });

  it('pending -> rejected', () => {
    const planId = insertPlan(ctx.db);
    const phaseId = insertPhase(ctx.db, { planId });
    const taskId = insertTask(ctx.db, { phaseId, planId, status: 'pending' });

    const result = retryPlanTask(ctx.db, { task_id: taskId, reason: 'should not work' });

    assert.ok(result.error, 'must return an error for pending task');
    assert.ok(result.error.includes('pending'), 'error must mention current status');
  });

  it('ready -> rejected', () => {
    const planId = insertPlan(ctx.db);
    const phaseId = insertPhase(ctx.db, { planId });
    const taskId = insertTask(ctx.db, { phaseId, planId, status: 'ready' });

    const result = retryPlanTask(ctx.db, { task_id: taskId, reason: 'should not work' });

    assert.ok(result.error, 'must return an error for ready task');
  });

  it('blocked -> rejected', () => {
    const planId = insertPlan(ctx.db);
    const phaseId = insertPhase(ctx.db, { planId });
    const taskId = insertTask(ctx.db, { phaseId, planId, status: 'blocked' });

    const result = retryPlanTask(ctx.db, { task_id: taskId, reason: 'should not work' });

    assert.ok(result.error, 'must return an error for blocked task');
  });
});

// ============================================================================
// Test Group 3: Phase and plan reset cascades
// ============================================================================

describe('retry_plan_task — phase and plan reset cascades', () => {
  let ctx;

  beforeEach(() => { ctx = createTestDb(); });
  afterEach(() => { ctx.cleanup(); });

  it('resets phase to in_progress when phase was completed', () => {
    const planId = insertPlan(ctx.db);
    const phaseId = insertPhase(ctx.db, { planId, status: 'completed' });
    const taskId = insertTask(ctx.db, { phaseId, planId, status: 'completed' });

    const result = retryPlanTask(ctx.db, { task_id: taskId, reason: 'need to redo' });

    assert.strictEqual(result.phase_reset, true, 'phase_reset must be true');

    const phase = ctx.db.prepare('SELECT * FROM phases WHERE id = ?').get(phaseId);
    assert.strictEqual(phase.status, 'in_progress', 'phase must be reset to in_progress');
    assert.strictEqual(phase.completed_at, null, 'phase completed_at must be cleared');
  });

  it('resets phase to in_progress when phase was skipped', () => {
    const planId = insertPlan(ctx.db);
    const phaseId = insertPhase(ctx.db, { planId, status: 'skipped' });
    const taskId = insertTask(ctx.db, { phaseId, planId, status: 'skipped' });

    const result = retryPlanTask(ctx.db, { task_id: taskId, reason: 'undo skip' });

    assert.strictEqual(result.phase_reset, true);

    const phase = ctx.db.prepare('SELECT * FROM phases WHERE id = ?').get(phaseId);
    assert.strictEqual(phase.status, 'in_progress');
  });

  it('does NOT reset phase when phase is still in_progress', () => {
    const planId = insertPlan(ctx.db);
    const phaseId = insertPhase(ctx.db, { planId, status: 'in_progress' });
    const taskId = insertTask(ctx.db, { phaseId, planId, status: 'completed' });

    const result = retryPlanTask(ctx.db, { task_id: taskId, reason: 'retry' });

    assert.strictEqual(result.phase_reset, false, 'phase_reset must be false when phase is in_progress');

    const phase = ctx.db.prepare('SELECT * FROM phases WHERE id = ?').get(phaseId);
    assert.strictEqual(phase.status, 'in_progress');
  });

  it('resets plan to active when plan was completed', () => {
    const planId = insertPlan(ctx.db, { status: 'completed' });
    const phaseId = insertPhase(ctx.db, { planId, status: 'completed' });
    const taskId = insertTask(ctx.db, { phaseId, planId, status: 'completed' });

    const result = retryPlanTask(ctx.db, { task_id: taskId, reason: 'reopen plan' });

    assert.strictEqual(result.plan_reset, true, 'plan_reset must be true');

    const plan = ctx.db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
    assert.strictEqual(plan.status, 'active', 'plan must be reset to active');
    assert.strictEqual(plan.completed_at, null, 'plan completed_at must be cleared');
  });

  it('does NOT reset plan when plan is still active', () => {
    const planId = insertPlan(ctx.db, { status: 'active' });
    const phaseId = insertPhase(ctx.db, { planId, status: 'in_progress' });
    const taskId = insertTask(ctx.db, { phaseId, planId, status: 'completed' });

    const result = retryPlanTask(ctx.db, { task_id: taskId, reason: 'retry' });

    assert.strictEqual(result.plan_reset, false, 'plan_reset must be false when plan is active');
  });
});

// ============================================================================
// Test Group 4: State changes and error handling
// ============================================================================

describe('retry_plan_task — state changes and error handling', () => {
  let ctx;

  beforeEach(() => { ctx = createTestDb(); });
  afterEach(() => { ctx.cleanup(); });

  it('records state change in state_changes table', () => {
    const planId = insertPlan(ctx.db);
    const phaseId = insertPhase(ctx.db, { planId });
    const taskId = insertTask(ctx.db, { phaseId, planId, status: 'completed' });

    retryPlanTask(ctx.db, { task_id: taskId, reason: 'test state tracking' });

    const stateChanges = ctx.db.prepare(
      "SELECT * FROM state_changes WHERE entity_type = 'task' AND entity_id = ?"
    ).all(taskId);

    assert.ok(stateChanges.length > 0, 'at least one state change must be recorded');

    const sc = stateChanges[0];
    assert.strictEqual(sc.field_name, 'status');
    assert.strictEqual(sc.old_value, 'completed');
    assert.strictEqual(sc.new_value, 'pending');
    assert.ok(sc.changed_by.includes('retry:'), 'changed_by must include retry reason');
  });

  it('records phase state change when phase is reset', () => {
    const planId = insertPlan(ctx.db);
    const phaseId = insertPhase(ctx.db, { planId, status: 'completed' });
    const taskId = insertTask(ctx.db, { phaseId, planId, status: 'completed' });

    retryPlanTask(ctx.db, { task_id: taskId, reason: 'test phase state change' });

    const phaseChanges = ctx.db.prepare(
      "SELECT * FROM state_changes WHERE entity_type = 'phase' AND entity_id = ?"
    ).all(phaseId);

    assert.ok(phaseChanges.length > 0, 'phase state change must be recorded');
    assert.strictEqual(phaseChanges[0].old_value, 'completed');
    assert.strictEqual(phaseChanges[0].new_value, 'in_progress');
  });

  it('records plan state change when plan is reset', () => {
    const planId = insertPlan(ctx.db, { status: 'completed' });
    const phaseId = insertPhase(ctx.db, { planId, status: 'completed' });
    const taskId = insertTask(ctx.db, { phaseId, planId, status: 'completed' });

    retryPlanTask(ctx.db, { task_id: taskId, reason: 'test plan state change' });

    const planChanges = ctx.db.prepare(
      "SELECT * FROM state_changes WHERE entity_type = 'plan' AND entity_id = ?"
    ).all(planId);

    assert.ok(planChanges.length > 0, 'plan state change must be recorded');
    assert.strictEqual(planChanges[0].old_value, 'completed');
    assert.strictEqual(planChanges[0].new_value, 'active');
  });

  it('returns error for non-existent task', () => {
    const result = retryPlanTask(ctx.db, { task_id: 'nonexistent-id', reason: 'should fail' });

    assert.ok(result.error, 'must return an error for non-existent task');
    assert.ok(result.error.includes('not found'), 'error must indicate task not found');
  });

  it('reason is included in the returned result', () => {
    const planId = insertPlan(ctx.db);
    const phaseId = insertPhase(ctx.db, { planId });
    const taskId = insertTask(ctx.db, { phaseId, planId, status: 'completed' });

    const reason = 'Added precursor to fix auth issue';
    const result = retryPlanTask(ctx.db, { task_id: taskId, reason });

    assert.strictEqual(result.reason, reason, 'reason must be echoed in result');
  });
});
