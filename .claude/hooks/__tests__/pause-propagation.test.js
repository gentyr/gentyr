/**
 * Tests for lib/pause-propagation.js
 *
 * Validates:
 *   1.  propagatePauseToPlan() — no plan linkage → { propagated: false }
 *   2.  propagatePauseToPlan() — plan linked, no downstream deps → blocking_level: 'persistent_task', plan NOT auto-paused
 *   3.  propagatePauseToPlan() — downstream deps AND no parallel work → blocking_level: 'plan', plan auto-paused
 *   4.  propagatePauseToPlan() — downstream deps BUT parallel work available → blocking_level: 'persistent_task', plan NOT auto-paused
 *   5.  propagatePauseToPlan() — gate phase → blocking_level: 'plan', plan auto-paused
 *   6.  propagatePauseToPlan() — creates a blocking_queue record in bypass-requests.db
 *   7.  propagateResumeToPlan() — no plan linkage → { propagated: false }
 *   8.  propagateResumeToPlan() — transitions plan task from paused to in_progress
 *   9.  propagateResumeToPlan() — resolves active blocking_queue records
 *  10.  propagateResumeToPlan() — resumes auto-paused plan when no other paused tasks remain
 *  11.  propagateResumeToPlan() — does NOT resume plan when other paused tasks remain
 *  12.  assessPlanBlocking() — correct fully_blocked / partially_blocked assessment
 *  13.  Error handling — returns safe defaults when DBs don't exist
 *  14.  Error handling — returns safe defaults when DBs are corrupted / empty
 *
 * Strategy: create real SQLite databases in /tmp using the production schemas
 * (mirrored from server.ts files), point CLAUDE_PROJECT_DIR at the temp dir,
 * and import pause-propagation.js via a cache-busted dynamic import so the
 * module sees the correct PROJECT_DIR at load time.
 *
 * Run with: node --test .claude/hooks/__tests__/pause-propagation.test.js
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

// ============================================================================
// Schemas — mirrored from server.ts files
// ============================================================================

const PERSISTENT_TASKS_SCHEMA = `
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

CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    persistent_task_id TEXT NOT NULL REFERENCES persistent_tasks(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    details TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_task ON events(persistent_task_id);
`;

const PLANS_SCHEMA = `
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
    persistent_task_id TEXT,
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
    required INTEGER NOT NULL DEFAULT 1,
    gate INTEGER NOT NULL DEFAULT 0,
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
    persistent_task_id TEXT,
    CONSTRAINT valid_task_status CHECK (status IN ('pending','blocked','ready','in_progress','paused','pending_audit','completed','skipped'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_phase ON plan_tasks(phase_id);
CREATE INDEX IF NOT EXISTS idx_tasks_plan ON plan_tasks(plan_id);

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
`;

// ============================================================================
// Helpers
// ============================================================================

function generateId(prefix = 'id') {
  return `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
}

const NOW = new Date().toISOString();

/**
 * Create a temp project directory with .claude/state/ and all three DBs
 * (persistent-tasks.db, plans.db, bypass-requests.db).
 * Returns { projectDir, ptDb, plansDb, bypassDb, stateDir, cleanup }.
 */
function createTestProject(prefix = 'pause-prop-test') {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
  const stateDir = path.join(projectDir, '.claude', 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  const ptDbPath = path.join(stateDir, 'persistent-tasks.db');
  const plansDbPath = path.join(stateDir, 'plans.db');
  const bypassDbPath = path.join(stateDir, 'bypass-requests.db');

  const ptDb = new Database(ptDbPath);
  ptDb.pragma('journal_mode = WAL');
  ptDb.pragma('busy_timeout = 3000');
  ptDb.exec(PERSISTENT_TASKS_SCHEMA);

  const plansDb = new Database(plansDbPath);
  plansDb.pragma('journal_mode = WAL');
  plansDb.pragma('busy_timeout = 3000');
  plansDb.exec(PLANS_SCHEMA);

  const bypassDb = new Database(bypassDbPath);
  bypassDb.pragma('journal_mode = WAL');
  bypassDb.pragma('busy_timeout = 3000');
  // Create a minimal bypass_requests table so ensureBlockingQueueTable can run in the same DB
  bypassDb.exec(`
    CREATE TABLE IF NOT EXISTS bypass_requests (
      id TEXT PRIMARY KEY,
      task_type TEXT NOT NULL,
      task_id TEXT NOT NULL,
      task_title TEXT,
      agent_id TEXT,
      category TEXT NOT NULL DEFAULT 'general',
      summary TEXT NOT NULL,
      details TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      resolution_context TEXT,
      resolved_at TEXT,
      resolved_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (task_type IN ('persistent', 'todo')),
      CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
      CHECK (category IN ('destructive_operation', 'scope_change', 'ambiguous_requirement', 'resource_access', 'general'))
    );
  `);

  return {
    projectDir,
    stateDir,
    ptDb,
    ptDbPath,
    plansDb,
    plansDbPath,
    bypassDb,
    bypassDbPath,
    cleanup() {
      try { ptDb.close(); } catch (_) { /* non-fatal */ }
      try { plansDb.close(); } catch (_) { /* non-fatal */ }
      try { bypassDb.close(); } catch (_) { /* non-fatal */ }
      try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch (_) { /* non-fatal */ }
    },
  };
}

/**
 * Insert a persistent task row with metadata pointing at a plan task.
 */
function insertPersistentTask(db, {
  id = generateId('pt'),
  title = 'Test persistent task',
  status = 'active',
  planTaskId = null,
  planId = null,
  metadata = null,
} = {}) {
  const meta = metadata ?? (planTaskId && planId ? JSON.stringify({ plan_task_id: planTaskId, plan_id: planId }) : null);
  db.prepare(`
    INSERT INTO persistent_tasks (id, title, prompt, status, created_at, metadata)
    VALUES (?, ?, 'Test prompt', ?, ?, ?)
  `).run(id, title, status, NOW, meta);
  return id;
}

/**
 * Insert a plan row.
 */
function insertPlan(db, {
  id = generateId('plan'),
  title = 'Test Plan',
  status = 'active',
} = {}) {
  db.prepare(`
    INSERT INTO plans (id, title, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, title, status, NOW, NOW);
  return id;
}

/**
 * Insert a phase row. Set gate=1 for gate phases.
 */
function insertPhase(db, {
  id = generateId('phase'),
  planId,
  title = 'Test Phase',
  status = 'in_progress',
  gate = 0,
  required = 1,
  phaseOrder = 1,
} = {}) {
  db.prepare(`
    INSERT INTO phases (id, plan_id, title, status, phase_order, required, gate, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, planId, title, status, phaseOrder, required, gate, NOW, NOW);
  return id;
}

/**
 * Insert a plan_task row.
 */
function insertPlanTask(db, {
  id = generateId('task'),
  phaseId,
  planId,
  title = 'Test Task',
  status = 'in_progress',
  taskOrder = 1,
  persistentTaskId = null,
} = {}) {
  db.prepare(`
    INSERT INTO plan_tasks (id, phase_id, plan_id, title, status, task_order, persistent_task_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, phaseId, planId, title, status, taskOrder, persistentTaskId, NOW, NOW);
  return id;
}

/**
 * Insert a dependency row (task-level).
 */
function insertDependency(db, { blockerId, blockedId }) {
  const id = generateId('dep');
  db.prepare(`
    INSERT INTO dependencies (id, blocker_type, blocker_id, blocked_type, blocked_id, created_at)
    VALUES (?, 'task', ?, 'task', ?, ?)
  `).run(id, blockerId, blockedId, NOW);
  return id;
}

// ============================================================================
// Module import with env-var injection
// ============================================================================

let propagatePauseToPlan;
let propagateResumeToPlan;
let assessPlanBlocking;
let testProject;

before(async () => {
  testProject = createTestProject('pause-prop-main');
  process.env.CLAUDE_PROJECT_DIR = testProject.projectDir;

  // Cache-bust so the module re-evaluates PROJECT_DIR with the new env.
  const mod = await import(
    new URL('../lib/pause-propagation.js', import.meta.url).href + `?bust=${Date.now()}`
  );
  propagatePauseToPlan = mod.propagatePauseToPlan;
  propagateResumeToPlan = mod.propagateResumeToPlan;
  assessPlanBlocking = mod.assessPlanBlocking;
});

after(() => {
  testProject?.cleanup();
});

// ============================================================================
// propagatePauseToPlan()
// ============================================================================

describe('propagatePauseToPlan()', () => {

  // ---- Test 1: No plan linkage ----

  it('returns { propagated: false } when persistent task has no plan linkage (no metadata)', () => {
    const ptId = insertPersistentTask(testProject.ptDb, { metadata: null });

    const result = propagatePauseToPlan(ptId, 'test reason');

    assert.strictEqual(result.propagated, false);
    assert.ok(!result.error, `unexpected error: ${result.error}`);
  });

  it('returns { propagated: false } when persistent task has metadata but no plan_task_id', () => {
    const ptId = insertPersistentTask(testProject.ptDb, {
      metadata: JSON.stringify({ some_other_field: 'value' }),
    });

    const result = propagatePauseToPlan(ptId, 'test reason');

    assert.strictEqual(result.propagated, false);
  });

  it('returns { propagated: false } when persistent task does not exist in DB', () => {
    const result = propagatePauseToPlan('nonexistent-pt-id', 'test reason');

    assert.strictEqual(result.propagated, false);
  });

  it('returns { propagated: false } when persistentTaskId is null or undefined', () => {
    assert.deepStrictEqual(propagatePauseToPlan(null, 'reason'), { propagated: false });
    assert.deepStrictEqual(propagatePauseToPlan(undefined, 'reason'), { propagated: false });
    assert.deepStrictEqual(propagatePauseToPlan('', 'reason'), { propagated: false });
  });

  // ---- Test 2: Plan linked, no downstream deps → blocking_level: 'persistent_task' ----

  it('returns blocking_level: "persistent_task" when no downstream dependencies exist', () => {
    const planId = insertPlan(testProject.plansDb, { status: 'active' });
    const phaseId = insertPhase(testProject.plansDb, { planId, gate: 0 });
    const planTaskId = insertPlanTask(testProject.plansDb, { phaseId, planId, status: 'in_progress' });
    const ptId = insertPersistentTask(testProject.ptDb, { planTaskId, planId });

    const result = propagatePauseToPlan(ptId, 'no deps test');

    assert.strictEqual(result.propagated, true);
    assert.strictEqual(result.blocking_level, 'persistent_task');
    assert.strictEqual(result.plan_auto_paused, false);
    assert.ok(result.impact);
    assert.deepStrictEqual(result.impact.blocked_tasks, []);
    assert.strictEqual(result.impact.blocks_phase, false);

    // Plan must remain active
    const plan = testProject.plansDb.prepare('SELECT status FROM plans WHERE id = ?').get(planId);
    assert.strictEqual(plan.status, 'active');
  });

  // ---- Test 3: Downstream deps AND no parallel work → 'plan', plan auto-paused ----

  it('returns blocking_level: "plan" and auto-pauses the plan when downstream deps exist and no parallel work', () => {
    const planId = insertPlan(testProject.plansDb, { status: 'active' });
    const phaseId = insertPhase(testProject.plansDb, { planId, gate: 0 });
    const blockerTaskId = insertPlanTask(testProject.plansDb, { phaseId, planId, status: 'in_progress', taskOrder: 1 });
    const blockedTaskId = insertPlanTask(testProject.plansDb, { phaseId, planId, status: 'pending', taskOrder: 2 });
    // No parallel work: only the blocked task exists and it's pending (not in_progress or ready)
    insertDependency(testProject.plansDb, { blockerId: blockerTaskId, blockedId: blockedTaskId });
    const ptId = insertPersistentTask(testProject.ptDb, { planTaskId: blockerTaskId, planId });

    const result = propagatePauseToPlan(ptId, 'blocking test');

    assert.strictEqual(result.propagated, true);
    assert.strictEqual(result.blocking_level, 'plan');
    assert.strictEqual(result.plan_auto_paused, true);
    assert.ok(result.impact.blocked_tasks.includes(blockedTaskId));
    assert.strictEqual(result.impact.blocks_phase, true);
    assert.strictEqual(result.impact.parallel_paths_available, false);

    // Plan must be paused
    const plan = testProject.plansDb.prepare('SELECT status FROM plans WHERE id = ?').get(planId);
    assert.strictEqual(plan.status, 'paused');

    // Plan task must be paused
    const task = testProject.plansDb.prepare('SELECT status FROM plan_tasks WHERE id = ?').get(blockerTaskId);
    assert.strictEqual(task.status, 'paused');

    // State change recorded
    const change = testProject.plansDb.prepare(
      "SELECT * FROM state_changes WHERE entity_id = ? AND new_value = 'paused'"
    ).get(blockerTaskId);
    assert.ok(change, 'state_changes must record the task pause');
  });

  // ---- Test 4: Downstream deps BUT parallel work → 'persistent_task', plan NOT auto-paused ----

  it('returns blocking_level: "persistent_task" when downstream deps exist but parallel work is available', () => {
    const planId = insertPlan(testProject.plansDb, { status: 'active' });
    const phaseId = insertPhase(testProject.plansDb, { planId, gate: 0 });
    const blockerTaskId = insertPlanTask(testProject.plansDb, { phaseId, planId, status: 'in_progress', taskOrder: 1 });
    const blockedTaskId = insertPlanTask(testProject.plansDb, { phaseId, planId, status: 'pending', taskOrder: 2 });
    // Parallel task that is in_progress — this makes parallelWorkCount > 0
    const parallelTaskId = insertPlanTask(testProject.plansDb, { phaseId, planId, status: 'in_progress', taskOrder: 3 });
    insertDependency(testProject.plansDb, { blockerId: blockerTaskId, blockedId: blockedTaskId });
    const ptId = insertPersistentTask(testProject.ptDb, { planTaskId: blockerTaskId, planId });

    const result = propagatePauseToPlan(ptId, 'parallel work test');

    assert.strictEqual(result.propagated, true);
    assert.strictEqual(result.blocking_level, 'persistent_task');
    assert.strictEqual(result.plan_auto_paused, false);
    assert.strictEqual(result.impact.parallel_paths_available, true);
    assert.ok(result.impact.blocked_tasks.includes(blockedTaskId));

    // Plan must remain active
    const plan = testProject.plansDb.prepare('SELECT status FROM plans WHERE id = ?').get(planId);
    assert.strictEqual(plan.status, 'active');

    // Clean up the parallel task so it doesn't pollute later tests
    testProject.plansDb.prepare('DELETE FROM plan_tasks WHERE id = ?').run(parallelTaskId);
  });

  // ---- Test 5: Gate phase → 'plan', plan auto-paused ----

  it('returns blocking_level: "plan" when task is in a gate phase, even with no downstream deps', () => {
    const planId = insertPlan(testProject.plansDb, { status: 'active' });
    // gate=1 means this is a gate phase
    const gatePhaseId = insertPhase(testProject.plansDb, { planId, gate: 1 });
    const gateTaskId = insertPlanTask(testProject.plansDb, { phaseId: gatePhaseId, planId, status: 'in_progress' });
    // No downstream deps at all
    const ptId = insertPersistentTask(testProject.ptDb, { planTaskId: gateTaskId, planId });

    const result = propagatePauseToPlan(ptId, 'gate phase test');

    assert.strictEqual(result.propagated, true);
    assert.strictEqual(result.blocking_level, 'plan');
    assert.strictEqual(result.plan_auto_paused, true);
    assert.strictEqual(result.impact.is_gate, true);

    // Plan must be paused
    const plan = testProject.plansDb.prepare('SELECT status FROM plans WHERE id = ?').get(planId);
    assert.strictEqual(plan.status, 'paused');
  });

  // ---- Test 6: Creates blocking_queue record ----

  it('creates a blocking_queue record in bypass-requests.db', () => {
    const planId = insertPlan(testProject.plansDb, { title: 'Queue Test Plan', status: 'active' });
    const phaseId = insertPhase(testProject.plansDb, { planId, gate: 0 });
    const planTaskId = insertPlanTask(testProject.plansDb, { phaseId, planId, status: 'in_progress' });
    const ptId = insertPersistentTask(testProject.ptDb, { planTaskId, planId });
    const bypassReqId = 'bypass-req-' + generateId();

    const result = propagatePauseToPlan(ptId, 'blocking queue test', bypassReqId);

    assert.strictEqual(result.propagated, true);
    assert.ok(result.blocking_queue_id, 'blocking_queue_id must be returned');
    assert.ok(result.blocking_queue_id.startsWith('block-'), 'blocking_queue_id must start with "block-"');

    // Verify the record was inserted
    // Re-open bypass DB to check
    const bDb = new Database(testProject.bypassDbPath, { readonly: true });
    const row = bDb.prepare('SELECT * FROM blocking_queue WHERE id = ?').get(result.blocking_queue_id);
    bDb.close();

    assert.ok(row, 'blocking_queue row must exist');
    assert.strictEqual(row.status, 'active');
    assert.strictEqual(row.persistent_task_id, ptId);
    assert.strictEqual(row.plan_id, planId);
    assert.strictEqual(row.plan_task_id, planTaskId);
    assert.strictEqual(row.bypass_request_id, bypassReqId);
    assert.strictEqual(row.summary, 'blocking queue test');
  });

  it('creates blocking_queue record with default summary when pauseReason is omitted', () => {
    const planId = insertPlan(testProject.plansDb, { status: 'active' });
    const phaseId = insertPhase(testProject.plansDb, { planId });
    const planTaskId = insertPlanTask(testProject.plansDb, { phaseId, planId, status: 'in_progress' });
    const ptId = insertPersistentTask(testProject.ptDb, { planTaskId, planId });

    const result = propagatePauseToPlan(ptId); // no pauseReason

    assert.strictEqual(result.propagated, true);
    const bDb = new Database(testProject.bypassDbPath, { readonly: true });
    const row = bDb.prepare('SELECT * FROM blocking_queue WHERE id = ?').get(result.blocking_queue_id);
    bDb.close();

    assert.ok(row, 'blocking_queue row must exist');
    assert.strictEqual(row.summary, 'Persistent task paused', 'default summary must be used when pauseReason omitted');
  });

});

// ============================================================================
// propagateResumeToPlan()
// ============================================================================

describe('propagateResumeToPlan()', () => {

  // ---- Test 7: No plan linkage → { propagated: false } ----

  it('returns { propagated: false } when persistent task has no plan linkage', () => {
    const ptId = insertPersistentTask(testProject.ptDb, { metadata: null });

    const result = propagateResumeToPlan(ptId);

    assert.strictEqual(result.propagated, false);
    assert.ok(!result.error, `unexpected error: ${result.error}`);
  });

  it('returns { propagated: false } when persistentTaskId is null or empty', () => {
    assert.deepStrictEqual(propagateResumeToPlan(null), { propagated: false });
    assert.deepStrictEqual(propagateResumeToPlan(''), { propagated: false });
    assert.deepStrictEqual(propagateResumeToPlan(undefined), { propagated: false });
  });

  // ---- Test 8: Transitions plan task from paused to in_progress ----

  it('transitions plan task from paused to in_progress on resume', () => {
    const planId = insertPlan(testProject.plansDb, { status: 'active' });
    const phaseId = insertPhase(testProject.plansDb, { planId });
    // Insert task already in paused state (as if propagatePauseToPlan ran before)
    const planTaskId = insertPlanTask(testProject.plansDb, { phaseId, planId, status: 'paused' });
    const ptId = insertPersistentTask(testProject.ptDb, { planTaskId, planId });

    const result = propagateResumeToPlan(ptId);

    assert.strictEqual(result.propagated, true);

    // Plan task must be back to in_progress
    const task = testProject.plansDb.prepare('SELECT status FROM plan_tasks WHERE id = ?').get(planTaskId);
    assert.strictEqual(task.status, 'in_progress');

    // State change must be recorded
    const change = testProject.plansDb.prepare(
      "SELECT * FROM state_changes WHERE entity_id = ? AND new_value = 'in_progress' AND old_value = 'paused'"
    ).get(planTaskId);
    assert.ok(change, 'state_changes must record the task resume');
  });

  it('is idempotent — does not error when plan task is already in_progress', () => {
    const planId = insertPlan(testProject.plansDb, { status: 'active' });
    const phaseId = insertPhase(testProject.plansDb, { planId });
    // Task is already in_progress — resume should be a no-op but not error
    const planTaskId = insertPlanTask(testProject.plansDb, { phaseId, planId, status: 'in_progress' });
    const ptId = insertPersistentTask(testProject.ptDb, { planTaskId, planId });

    const result = propagateResumeToPlan(ptId);

    // Still propagated=true (plan linkage exists), but task already in correct state
    assert.strictEqual(result.propagated, true);
    assert.ok(!result.error);
  });

  // ---- Test 9: Resolves blocking_queue records ----

  it('resolves active blocking_queue records in bypass-requests.db', () => {
    const planId = insertPlan(testProject.plansDb, { status: 'paused' });
    const phaseId = insertPhase(testProject.plansDb, { planId });
    const planTaskId = insertPlanTask(testProject.plansDb, { phaseId, planId, status: 'paused' });
    const ptId = insertPersistentTask(testProject.ptDb, { planTaskId, planId });

    // Insert an active blocking_queue record manually.
    // Ensure the table exists with the canonical schema (mirrors ensureBlockingQueueTable in
    // pause-propagation.js). source_task_type is NOT NULL with no DEFAULT.
    testProject.bypassDb.exec(`
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
      )
    `);
    const bqId = 'block-' + generateId();
    testProject.bypassDb.prepare(`
      INSERT INTO blocking_queue (id, source_task_type, source_task_id, persistent_task_id, plan_task_id, plan_id, blocking_level, summary, status)
      VALUES (?, 'persistent', ?, ?, ?, ?, 'plan', 'test block', 'active')
    `).run(bqId, ptId, ptId, planTaskId, planId);

    const result = propagateResumeToPlan(ptId);

    assert.strictEqual(result.propagated, true);
    assert.ok(result.blocking_items_resolved >= 1, `expected at least 1 resolved, got ${result.blocking_items_resolved}`);

    // The blocking_queue row must now be 'resolved'
    const row = testProject.bypassDb.prepare('SELECT status FROM blocking_queue WHERE id = ?').get(bqId);
    assert.strictEqual(row.status, 'resolved');
  });

  // ---- Test 10: Resumes auto-paused plan when no other paused tasks remain ----

  it('resumes the plan when it was paused and no other paused tasks remain', () => {
    const planId = insertPlan(testProject.plansDb, { status: 'paused' });
    const phaseId = insertPhase(testProject.plansDb, { planId });
    // Only one paused task — after resume no others remain paused
    const planTaskId = insertPlanTask(testProject.plansDb, { phaseId, planId, status: 'paused' });
    const ptId = insertPersistentTask(testProject.ptDb, { planTaskId, planId });

    const result = propagateResumeToPlan(ptId);

    assert.strictEqual(result.propagated, true);
    assert.strictEqual(result.plan_resumed, true);

    // Plan must be active again
    const plan = testProject.plansDb.prepare('SELECT status FROM plans WHERE id = ?').get(planId);
    assert.strictEqual(plan.status, 'active');

    // State change recorded for plan resume
    const change = testProject.plansDb.prepare(
      "SELECT * FROM state_changes WHERE entity_id = ? AND new_value = 'active' AND old_value = 'paused'"
    ).get(planId);
    assert.ok(change, 'state_changes must record the plan resume');
  });

  // ---- Test 11: Does NOT resume plan when other paused tasks remain ----

  it('does NOT resume the plan when other plan tasks are still paused', () => {
    const planId = insertPlan(testProject.plansDb, { status: 'paused' });
    const phaseId = insertPhase(testProject.plansDb, { planId });
    const planTaskId = insertPlanTask(testProject.plansDb, { phaseId, planId, status: 'paused', taskOrder: 1 });
    // Another paused task that will keep the plan paused
    const otherPausedTaskId = insertPlanTask(testProject.plansDb, { phaseId, planId, status: 'paused', taskOrder: 2 });
    const ptId = insertPersistentTask(testProject.ptDb, { planTaskId, planId });

    const result = propagateResumeToPlan(ptId);

    assert.strictEqual(result.propagated, true);
    assert.strictEqual(result.plan_resumed, false);

    // Plan must still be paused
    const plan = testProject.plansDb.prepare('SELECT status FROM plans WHERE id = ?').get(planId);
    assert.strictEqual(plan.status, 'paused');

    // Clean up
    testProject.plansDb.prepare('DELETE FROM plan_tasks WHERE id = ?').run(otherPausedTaskId);
  });

  it('does NOT resume plan when plan was never paused (status is active)', () => {
    const planId = insertPlan(testProject.plansDb, { status: 'active' });
    const phaseId = insertPhase(testProject.plansDb, { planId });
    const planTaskId = insertPlanTask(testProject.plansDb, { phaseId, planId, status: 'paused' });
    const ptId = insertPersistentTask(testProject.ptDb, { planTaskId, planId });

    const result = propagateResumeToPlan(ptId);

    assert.strictEqual(result.propagated, true);
    assert.strictEqual(result.plan_resumed, false);

    // Plan must remain active (unchanged)
    const plan = testProject.plansDb.prepare('SELECT status FROM plans WHERE id = ?').get(planId);
    assert.strictEqual(plan.status, 'active');
  });

});

// ============================================================================
// assessPlanBlocking()
// ============================================================================

describe('assessPlanBlocking()', () => {

  // ---- Test 12: Correct fully_blocked / partially_blocked assessment ----

  it('returns fully_blocked=true when all paused tasks have downstream deps and no parallel work', () => {
    const planId = insertPlan(testProject.plansDb, { status: 'paused' });
    const phaseId = insertPhase(testProject.plansDb, { planId });
    const pausedTaskId = insertPlanTask(testProject.plansDb, { phaseId, planId, status: 'paused', taskOrder: 1 });
    const blockedTaskId = insertPlanTask(testProject.plansDb, { phaseId, planId, status: 'pending', taskOrder: 2 });
    insertDependency(testProject.plansDb, { blockerId: pausedTaskId, blockedId: blockedTaskId });
    // No in_progress or ready tasks

    const result = assessPlanBlocking(planId);

    assert.strictEqual(result.fully_blocked, true);
    assert.strictEqual(result.partially_blocked, false);
    assert.ok(result.paused_tasks.length >= 1);
    assert.ok(result.paused_tasks.some(pt => pt.id === pausedTaskId));
    assert.ok(result.available_parallel_work.length === 0);
    assert.ok(!result.error);
  });

  it('returns partially_blocked=true when paused tasks exist but parallel work is available', () => {
    const planId = insertPlan(testProject.plansDb, { status: 'active' });
    const phaseId = insertPhase(testProject.plansDb, { planId });
    const pausedTaskId = insertPlanTask(testProject.plansDb, { phaseId, planId, status: 'paused', taskOrder: 1 });
    const parallelTaskId = insertPlanTask(testProject.plansDb, { phaseId, planId, status: 'in_progress', taskOrder: 2 });

    const result = assessPlanBlocking(planId);

    assert.strictEqual(result.fully_blocked, false);
    assert.strictEqual(result.partially_blocked, true);
    assert.ok(result.paused_tasks.some(pt => pt.id === pausedTaskId));
    assert.ok(result.available_parallel_work.some(w => w.id === parallelTaskId));

    // Clean up
    testProject.plansDb.prepare('DELETE FROM plan_tasks WHERE id = ?').run(parallelTaskId);
  });

  it('returns fully_blocked=false and partially_blocked=false when no paused tasks exist', () => {
    const planId = insertPlan(testProject.plansDb, { status: 'active' });
    const phaseId = insertPhase(testProject.plansDb, { planId });
    insertPlanTask(testProject.plansDb, { phaseId, planId, status: 'in_progress' });

    const result = assessPlanBlocking(planId);

    assert.strictEqual(result.fully_blocked, false);
    assert.strictEqual(result.partially_blocked, false);
    assert.deepStrictEqual(result.paused_tasks, []);
    assert.ok(!result.error);
  });

  it('returns paused_tasks with blocked_task_ids populated', () => {
    const planId = insertPlan(testProject.plansDb, { status: 'paused' });
    const phaseId = insertPhase(testProject.plansDb, { planId });
    const pausedTaskId = insertPlanTask(testProject.plansDb, { phaseId, planId, status: 'paused', taskOrder: 1 });
    const dep1Id = insertPlanTask(testProject.plansDb, { phaseId, planId, status: 'pending', taskOrder: 2 });
    const dep2Id = insertPlanTask(testProject.plansDb, { phaseId, planId, status: 'pending', taskOrder: 3 });
    insertDependency(testProject.plansDb, { blockerId: pausedTaskId, blockedId: dep1Id });
    insertDependency(testProject.plansDb, { blockerId: pausedTaskId, blockedId: dep2Id });

    const result = assessPlanBlocking(planId);

    const pausedTask = result.paused_tasks.find(pt => pt.id === pausedTaskId);
    assert.ok(pausedTask, 'paused task must appear in result');
    assert.ok(pausedTask.blocked_task_ids.includes(dep1Id), 'dep1 must be in blocked_task_ids');
    assert.ok(pausedTask.blocked_task_ids.includes(dep2Id), 'dep2 must be in blocked_task_ids');
  });

  it('returns safe default when planId is null or empty', () => {
    const safe = { fully_blocked: false, partially_blocked: false, paused_tasks: [], available_parallel_work: [], blocking_items: [] };
    assert.deepStrictEqual(assessPlanBlocking(null), safe);
    assert.deepStrictEqual(assessPlanBlocking(''), safe);
    assert.deepStrictEqual(assessPlanBlocking(undefined), safe);
  });

  it('includes active blocking_items from bypass-requests.db', () => {
    const planId = insertPlan(testProject.plansDb, { status: 'paused' });
    const phaseId = insertPhase(testProject.plansDb, { planId });
    const pausedTaskId = insertPlanTask(testProject.plansDb, { phaseId, planId, status: 'paused' });

    // Insert an active blocking_queue record for this plan
    const bqId = 'block-assess-' + generateId();
    testProject.bypassDb.prepare(`
      INSERT OR IGNORE INTO blocking_queue (id, source_task_type, source_task_id, persistent_task_id, plan_task_id, plan_id, blocking_level, summary, status)
      VALUES (?, 'persistent', 'pt-x', 'pt-x', ?, ?, 'plan', 'assessment block test', 'active')
    `).run(bqId, pausedTaskId, planId);

    const result = assessPlanBlocking(planId);

    assert.ok(Array.isArray(result.blocking_items));
    assert.ok(result.blocking_items.some(bi => bi.id === bqId), 'active blocking_queue item must appear in blocking_items');
  });

});

// ============================================================================
// Test 13 & 14: Error handling — missing or corrupted DBs
// ============================================================================

describe('Error handling — missing and corrupted DBs', () => {

  it('propagatePauseToPlan() returns { propagated: false } when persistent-tasks.db does not exist', async () => {
    // Create a project dir with no persistent-tasks.db
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pause-prop-no-ptdb-'));
    fs.mkdirSync(path.join(emptyDir, '.claude', 'state'), { recursive: true });
    const origDir = process.env.CLAUDE_PROJECT_DIR;

    // Re-import with empty project dir
    process.env.CLAUDE_PROJECT_DIR = emptyDir;
    const mod2 = await import(
      new URL('../lib/pause-propagation.js', import.meta.url).href + `?bust2=${Date.now()}`
    );
    const fn = mod2.propagatePauseToPlan;
    process.env.CLAUDE_PROJECT_DIR = origDir;

    const result = fn('any-pt-id', 'test');
    assert.strictEqual(result.propagated, false);

    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  it('propagateResumeToPlan() returns { propagated: false } when persistent-tasks.db does not exist', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pause-prop-no-ptdb-resume-'));
    fs.mkdirSync(path.join(emptyDir, '.claude', 'state'), { recursive: true });
    const origDir = process.env.CLAUDE_PROJECT_DIR;

    process.env.CLAUDE_PROJECT_DIR = emptyDir;
    const mod2 = await import(
      new URL('../lib/pause-propagation.js', import.meta.url).href + `?bust3=${Date.now()}`
    );
    const fn = mod2.propagateResumeToPlan;
    process.env.CLAUDE_PROJECT_DIR = origDir;

    const result = fn('any-pt-id');
    assert.strictEqual(result.propagated, false);

    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  it('assessPlanBlocking() returns safe defaults when plans.db does not exist', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pause-prop-no-plansdb-'));
    fs.mkdirSync(path.join(emptyDir, '.claude', 'state'), { recursive: true });
    const origDir = process.env.CLAUDE_PROJECT_DIR;

    process.env.CLAUDE_PROJECT_DIR = emptyDir;
    const mod2 = await import(
      new URL('../lib/pause-propagation.js', import.meta.url).href + `?bust4=${Date.now()}`
    );
    const fn = mod2.assessPlanBlocking;
    process.env.CLAUDE_PROJECT_DIR = origDir;

    const result = fn('any-plan-id');
    assert.strictEqual(result.fully_blocked, false);
    assert.strictEqual(result.partially_blocked, false);
    assert.deepStrictEqual(result.paused_tasks, []);
    assert.deepStrictEqual(result.available_parallel_work, []);
    assert.deepStrictEqual(result.blocking_items, []);

    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  it('propagatePauseToPlan() returns { propagated: false } when persistent task metadata is malformed JSON', () => {
    // Insert a persistent task with corrupt metadata
    const ptId = generateId('pt-corrupt');
    testProject.ptDb.prepare(`
      INSERT INTO persistent_tasks (id, title, prompt, status, created_at, metadata)
      VALUES (?, 'Corrupt Task', 'prompt', 'active', ?, ?)
    `).run(ptId, NOW, '{not valid json >>>');

    const result = propagatePauseToPlan(ptId, 'test');

    assert.strictEqual(result.propagated, false);
  });

  it('propagatePauseToPlan() returns error info (not throw) when plans.db is missing after persistent task is found', async () => {
    // Set up a project where persistent-tasks.db exists but plans.db does not
    const partialDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pause-prop-partial-'));
    const stateDir = path.join(partialDir, '.claude', 'state');
    fs.mkdirSync(stateDir, { recursive: true });

    // Create persistent-tasks.db only
    const ptDbPath = path.join(stateDir, 'persistent-tasks.db');
    const ptDb = new Database(ptDbPath);
    ptDb.exec(PERSISTENT_TASKS_SCHEMA);
    const ptId = 'pt-partial-' + generateId();
    ptDb.prepare(`
      INSERT INTO persistent_tasks (id, title, prompt, status, created_at, metadata)
      VALUES (?, 'Partial Task', 'prompt', 'active', ?, ?)
    `).run(ptId, NOW, JSON.stringify({ plan_task_id: 'task-x', plan_id: 'plan-x' }));
    ptDb.close();

    const origDir = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = partialDir;
    const mod2 = await import(
      new URL('../lib/pause-propagation.js', import.meta.url).href + `?bust5=${Date.now()}`
    );
    const fn = mod2.propagatePauseToPlan;
    process.env.CLAUDE_PROJECT_DIR = origDir;

    // Plans.db does not exist — must return { propagated: false } without throwing
    const result = fn(ptId, 'partial db test');
    assert.strictEqual(result.propagated, false);
    assert.ok(!result.error || typeof result.error === 'string', 'error if present must be a string');

    fs.rmSync(partialDir, { recursive: true, force: true });
  });
});
