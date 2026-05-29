/**
 * Tests for .claude/hooks/lib/audit-reset.js
 *
 * Covers the three reset entry points (resetTaskAudit, resetPtAudit,
 * resetPlanAudit) using in-memory SQLite mirroring the live schemas. Also
 * exercises the verifyResetAuditIdentity authorization predicate against a
 * temporary session-queue.db.
 *
 * Auditor respawn is bypassed via `respawn: false` to avoid pulling
 * session-queue.js + enqueueSession into the test fixture. The lib's own
 * lazy-load pattern (await import inside _respawnAuditor) makes that safe.
 *
 * Run with: node --test .claude/hooks/__tests__/audit-reset.test.js
 */

import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LIB_PATH = path.resolve(__dirname, '..', 'lib', 'audit-reset.js');

const TASK_SCHEMA = `
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT,
    status TEXT,
    gate_success_criteria TEXT,
    gate_verification_method TEXT,
    completed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS task_audits (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    success_criteria TEXT NOT NULL,
    verification_method TEXT NOT NULL,
    verdict TEXT,
    evidence TEXT,
    failure_reason TEXT,
    auditor_agent_id TEXT,
    requested_at TEXT NOT NULL,
    completed_at TEXT,
    attempt_number INTEGER DEFAULT 1
  );
`;
const PT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS persistent_tasks (
    id TEXT PRIMARY KEY,
    title TEXT,
    status TEXT,
    parent_todo_task_id TEXT,
    gate_success_criteria TEXT,
    gate_verification_method TEXT,
    completed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS pt_audits (
    id TEXT PRIMARY KEY,
    persistent_task_id TEXT NOT NULL,
    success_criteria TEXT NOT NULL,
    verification_method TEXT NOT NULL,
    verdict TEXT,
    evidence TEXT,
    failure_reason TEXT,
    auditor_agent_id TEXT,
    requested_at TEXT NOT NULL,
    completed_at TEXT,
    attempt_number INTEGER DEFAULT 1
  );
`;
const PLAN_SCHEMA = `
  CREATE TABLE IF NOT EXISTS plan_tasks (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    title TEXT,
    status TEXT,
    verification_strategy TEXT,
    persistent_task_id TEXT
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
    requested_at TEXT NOT NULL,
    completed_at TEXT,
    attempt_number INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT valid_audit_verdict CHECK (verdict IS NULL OR verdict IN ('pass','fail'))
  );
  CREATE TABLE IF NOT EXISTS state_changes (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    field_name TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT NOT NULL,
    changed_at TEXT NOT NULL,
    changed_by TEXT
  );
`;
const QUEUE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS queue_items (
    id TEXT PRIMARY KEY,
    agent TEXT,
    agent_type TEXT,
    metadata TEXT,
    status TEXT,
    lane TEXT,
    pid INTEGER,
    completed_at TEXT,
    error TEXT
  );
`;

let auditReset;
let tmpProjectDir;

before(async () => {
  auditReset = await import(LIB_PATH);
});

function makeProjectDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-reset-test-'));
  fs.mkdirSync(path.join(dir, '.claude', 'state'), { recursive: true });
  return dir;
}
function makeSessionQueueDb(projectDir, rows = []) {
  const dbPath = path.join(projectDir, '.claude', 'state', 'session-queue.db');
  const db = new Database(dbPath);
  db.exec(QUEUE_SCHEMA);
  for (const r of rows) {
    db.prepare(
      'INSERT INTO queue_items (id, agent, agent_type, metadata, status, lane) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(r.id, r.agent || null, r.agent_type || null, r.metadata || null, r.status || 'running', r.lane || 'audit');
  }
  db.close();
  return dbPath;
}

describe('verifyResetAuditIdentity', () => {
  beforeEach(() => {
    tmpProjectDir = makeProjectDir();
    delete process.env.CLAUDE_QUEUE_ID;
    delete process.env.CLAUDE_SPAWNED_SESSION;
    process.env.CLAUDE_PROJECT_DIR = tmpProjectDir;
  });
  afterEach(() => {
    delete process.env.CLAUDE_QUEUE_ID;
    delete process.env.CLAUDE_SPAWNED_SESSION;
    fs.rmSync(tmpProjectDir, { recursive: true, force: true });
  });

  it('allows interactive CTO (no queue id, not spawned)', () => {
    const res = auditReset.verifyResetAuditIdentity({ taskType: 'todo', taskId: 't1' });
    assert.equal(res.allowed, true);
    assert.equal(res.callerAgent, 'interactive');
  });

  it('denies spawned session without queue id', () => {
    process.env.CLAUDE_SPAWNED_SESSION = 'true';
    const res = auditReset.verifyResetAuditIdentity({ taskType: 'todo', taskId: 't1' });
    assert.equal(res.allowed, false);
    assert.match(res.reason, /spawned session without CLAUDE_QUEUE_ID/);
  });

  it('allows deputy-cto', () => {
    makeSessionQueueDb(tmpProjectDir, [
      { id: 'q1', agent: 'deputy-cto', agent_type: 'deputy-cto', status: 'running', lane: 'persistent' },
    ]);
    process.env.CLAUDE_QUEUE_ID = 'q1';
    const res = auditReset.verifyResetAuditIdentity({ taskType: 'persistent', taskId: 't1' });
    assert.equal(res.allowed, true);
    assert.equal(res.callerAgent, 'deputy-cto');
  });

  it('allows persistent-monitor', () => {
    makeSessionQueueDb(tmpProjectDir, [
      { id: 'q1', agent: 'persistent-monitor', agent_type: 'persistent-monitor', status: 'running', lane: 'persistent' },
    ]);
    process.env.CLAUDE_QUEUE_ID = 'q1';
    const res = auditReset.verifyResetAuditIdentity({ taskType: 'persistent', taskId: 't1' });
    assert.equal(res.allowed, true);
  });

  it('allows plan-manager', () => {
    makeSessionQueueDb(tmpProjectDir, [
      { id: 'q1', agent: 'plan-manager', agent_type: 'plan-manager', status: 'running', lane: 'persistent' },
    ]);
    process.env.CLAUDE_QUEUE_ID = 'q1';
    const res = auditReset.verifyResetAuditIdentity({ taskType: 'plan', taskId: 't1' });
    assert.equal(res.allowed, true);
  });

  it('denies universal-auditor (cannot reset itself)', () => {
    makeSessionQueueDb(tmpProjectDir, [
      { id: 'q1', agent: 'universal-auditor', agent_type: 'universal-auditor', status: 'running', lane: 'audit' },
    ]);
    process.env.CLAUDE_QUEUE_ID = 'q1';
    const res = auditReset.verifyResetAuditIdentity({ taskType: 'todo', taskId: 't1' });
    assert.equal(res.allowed, false);
    assert.match(res.reason, /cannot reset its own audit/);
  });

  it('denies plan-auditor (cannot reset itself)', () => {
    makeSessionQueueDb(tmpProjectDir, [
      { id: 'q1', agent: 'plan-auditor', agent_type: 'plan-auditor', status: 'running', lane: 'audit' },
    ]);
    process.env.CLAUDE_QUEUE_ID = 'q1';
    const res = auditReset.verifyResetAuditIdentity({ taskType: 'plan', taskId: 't1' });
    assert.equal(res.allowed, false);
    assert.match(res.reason, /cannot reset/);
  });

  it('denies task-runner', () => {
    makeSessionQueueDb(tmpProjectDir, [
      { id: 'q1', agent: 'task-runner', agent_type: 'task-runner', status: 'running', lane: 'standard' },
    ]);
    process.env.CLAUDE_QUEUE_ID = 'q1';
    const res = auditReset.verifyResetAuditIdentity({ taskType: 'todo', taskId: 't1' });
    assert.equal(res.allowed, false);
    assert.match(res.reason, /not authorized/);
  });

  it('denies when queue row not found (unknown queue id)', () => {
    makeSessionQueueDb(tmpProjectDir, []);
    process.env.CLAUDE_QUEUE_ID = 'q-bogus';
    const res = auditReset.verifyResetAuditIdentity({ taskType: 'todo', taskId: 't1' });
    assert.equal(res.allowed, false);
  });
});

describe('resetTaskAudit', () => {
  let db;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(TASK_SCHEMA);
    tmpProjectDir = makeProjectDir();
    process.env.CLAUDE_PROJECT_DIR = tmpProjectDir;
    delete process.env.CLAUDE_QUEUE_ID;
    delete process.env.CLAUDE_SPAWNED_SESSION;
  });
  afterEach(() => {
    db.close();
    fs.rmSync(tmpProjectDir, { recursive: true, force: true });
  });

  function seed(status = 'pending_audit', priorVerdict = null) {
    db.prepare("INSERT INTO tasks (id, title, status, gate_success_criteria, gate_verification_method) VALUES ('t1','Test task',?,?,?)")
      .run(status, 'Tests pass', 'pnpm test');
    db.prepare(
      "INSERT INTO task_audits (id, task_id, success_criteria, verification_method, verdict, requested_at, attempt_number) VALUES ('a1','t1','Tests pass','pnpm test',?,?,1)"
    ).run(priorVerdict, new Date().toISOString());
  }

  it('rejects too-short reason', async () => {
    seed();
    const res = await auditReset.resetTaskAudit({ db, taskId: 't1', reason: 'short', projectDir: tmpProjectDir, respawn: false });
    assert.ok(res.error);
    assert.match(res.error, /at least 10 characters/);
  });

  it('rejects unauthorized caller', async () => {
    seed();
    makeSessionQueueDb(tmpProjectDir, [
      { id: 'q1', agent: 'universal-auditor', agent_type: 'universal-auditor', status: 'running', lane: 'audit' },
    ]);
    process.env.CLAUDE_QUEUE_ID = 'q1';
    const res = await auditReset.resetTaskAudit({ db, taskId: 't1', reason: 'wedged auditor please reset', projectDir: tmpProjectDir, respawn: false });
    assert.ok(res.error);
    assert.match(res.error, /unauthorized/);
  });

  it('rejects unknown task', async () => {
    const res = await auditReset.resetTaskAudit({ db, taskId: 'missing', reason: 'wedged auditor please reset', projectDir: tmpProjectDir, respawn: false });
    assert.match(res.error, /task not found/);
  });

  it('rejects task with no audit history', async () => {
    db.prepare("INSERT INTO tasks (id, title, status, gate_success_criteria) VALUES ('t1','x','pending_audit','crit')").run();
    const res = await auditReset.resetTaskAudit({ db, taskId: 't1', reason: 'wedged auditor please reset', projectDir: tmpProjectDir, respawn: false });
    assert.match(res.error, /no audit history/);
  });

  it('rejects invalid status', async () => {
    db.prepare("INSERT INTO tasks (id, title, status, gate_success_criteria) VALUES ('t1','x','cancelled','crit')").run();
    db.prepare("INSERT INTO task_audits (id, task_id, success_criteria, verification_method, verdict, requested_at, attempt_number) VALUES ('a1','t1','crit','m','pass',?,1)")
      .run(new Date().toISOString());
    const res = await auditReset.resetTaskAudit({ db, taskId: 't1', reason: 'wedged auditor please reset', projectDir: tmpProjectDir, respawn: false });
    assert.match(res.error, /cannot reset audit for task in status 'cancelled'/);
  });

  it('resets pending_audit: marks prior failed, inserts new row, no status change', async () => {
    seed('pending_audit', null);
    const res = await auditReset.resetTaskAudit({ db, taskId: 't1', reason: 'wedged auditor please reset', projectDir: tmpProjectDir, respawn: false });
    assert.equal(res.error, undefined);
    assert.equal(res.task_id, 't1');
    assert.equal(res.prior_verdict, 'pending');
    assert.equal(res.new_status, 'pending_audit');
    assert.equal(res.new_attempt_number, 2);
    const prior = db.prepare('SELECT * FROM task_audits WHERE id = ?').get('a1');
    assert.equal(prior.verdict, 'fail');
    assert.match(prior.failure_reason, /Audit reset/);
    const audits = db.prepare('SELECT count(*) as c FROM task_audits WHERE task_id = ?').get('t1');
    assert.equal(audits.c, 2);
    const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get('t1');
    assert.equal(task.status, 'pending_audit');
  });

  it('resets completed (post audit-pass): reverts status, preserves prior verdict', async () => {
    seed('completed', 'pass');
    const res = await auditReset.resetTaskAudit({ db, taskId: 't1', reason: 'false-pass: criteria not actually met', projectDir: tmpProjectDir, respawn: false });
    assert.equal(res.error, undefined);
    assert.equal(res.prior_verdict, 'pass');
    assert.equal(res.prior_status, 'completed');
    assert.equal(res.new_status, 'pending_audit');
    // Prior pass row is preserved (verdict still 'pass') — only the new row replaces it
    const prior = db.prepare('SELECT verdict FROM task_audits WHERE id = ?').get('a1');
    assert.equal(prior.verdict, 'pass');
    const newRow = db.prepare('SELECT * FROM task_audits WHERE attempt_number = 2 AND task_id = ?').get('t1');
    assert.equal(newRow.verdict, null);
    assert.equal(newRow.attempt_number, 2);
    const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get('t1');
    assert.equal(task.status, 'pending_audit');
  });

  it('resets in_progress (post audit-fail): reverts to pending_audit', async () => {
    seed('in_progress', 'fail');
    const res = await auditReset.resetTaskAudit({ db, taskId: 't1', reason: 'false-fail: work clearly meets criteria', projectDir: tmpProjectDir, respawn: false });
    assert.equal(res.prior_verdict, 'fail');
    assert.equal(res.new_status, 'pending_audit');
    const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get('t1');
    assert.equal(task.status, 'pending_audit');
  });
});

describe('resetPtAudit', () => {
  let db;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(PT_SCHEMA);
    tmpProjectDir = makeProjectDir();
    process.env.CLAUDE_PROJECT_DIR = tmpProjectDir;
    delete process.env.CLAUDE_QUEUE_ID;
    delete process.env.CLAUDE_SPAWNED_SESSION;
  });
  afterEach(() => {
    db.close();
    fs.rmSync(tmpProjectDir, { recursive: true, force: true });
  });

  it('resets pending_audit and inserts new audit row', async () => {
    db.prepare("INSERT INTO persistent_tasks (id, title, status, gate_success_criteria, gate_verification_method) VALUES ('pt1','x','pending_audit','c','m')").run();
    db.prepare("INSERT INTO pt_audits (id, persistent_task_id, success_criteria, verification_method, verdict, requested_at, attempt_number) VALUES ('a1','pt1','c','m',NULL,?,1)").run(new Date().toISOString());
    const res = await auditReset.resetPtAudit({ db, taskId: 'pt1', reason: 'wedged auditor please reset', projectDir: tmpProjectDir, respawn: false });
    assert.equal(res.error, undefined);
    assert.equal(res.new_attempt_number, 2);
    assert.equal(db.prepare('SELECT count(*) as c FROM pt_audits WHERE persistent_task_id = ?').get('pt1').c, 2);
  });

  it('cascade-reverts parent todo task on completed PT reset', async () => {
    db.prepare("INSERT INTO persistent_tasks (id, title, status, parent_todo_task_id, gate_success_criteria, gate_verification_method) VALUES ('pt1','x','completed','todo1','c','m')").run();
    db.prepare("INSERT INTO pt_audits (id, persistent_task_id, success_criteria, verification_method, verdict, requested_at, attempt_number) VALUES ('a1','pt1','c','m','pass',?,1)").run(new Date().toISOString());
    // Build a real todo.db file in the temp dir so the cascade can find it.
    const todoDbPath = path.join(tmpProjectDir, '.claude', 'todo.db');
    const todoDb = new Database(todoDbPath);
    todoDb.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT, completed_at TEXT)");
    todoDb.prepare("INSERT INTO tasks (id, status, completed_at) VALUES ('todo1','completed','2026-01-01')").run();
    todoDb.close();

    const res = await auditReset.resetPtAudit({
      db, taskId: 'pt1', reason: 'false-pass cascaded into todo by mistake', projectDir: tmpProjectDir, todoDbPath, respawn: false,
    });
    assert.equal(res.error, undefined);
    assert.equal(res.cascaded_parent_todo_id, 'todo1');

    const verify = new Database(todoDbPath, { readonly: true });
    const row = verify.prepare("SELECT status FROM tasks WHERE id = 'todo1'").get();
    verify.close();
    assert.equal(row.status, 'pending_audit');
  });

  it('skips cascade when parent todo is not completed', async () => {
    db.prepare("INSERT INTO persistent_tasks (id, title, status, parent_todo_task_id, gate_success_criteria, gate_verification_method) VALUES ('pt1','x','pending_audit','todo1','c','m')").run();
    db.prepare("INSERT INTO pt_audits (id, persistent_task_id, success_criteria, verification_method, verdict, requested_at, attempt_number) VALUES ('a1','pt1','c','m',NULL,?,1)").run(new Date().toISOString());
    const todoDbPath = path.join(tmpProjectDir, '.claude', 'todo.db');
    const todoDb = new Database(todoDbPath);
    todoDb.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT, completed_at TEXT)");
    todoDb.prepare("INSERT INTO tasks (id, status) VALUES ('todo1','in_progress')").run();
    todoDb.close();

    const res = await auditReset.resetPtAudit({ db, taskId: 'pt1', reason: 'wedged auditor please reset', projectDir: tmpProjectDir, todoDbPath, respawn: false });
    assert.equal(res.cascaded_parent_todo_id, null);
  });
});

describe('resetPlanAudit', () => {
  let db;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(PLAN_SCHEMA);
    tmpProjectDir = makeProjectDir();
    process.env.CLAUDE_PROJECT_DIR = tmpProjectDir;
    delete process.env.CLAUDE_QUEUE_ID;
    delete process.env.CLAUDE_SPAWNED_SESSION;
  });
  afterEach(() => {
    db.close();
    fs.rmSync(tmpProjectDir, { recursive: true, force: true });
  });

  it('writes state_change row when reverting status', async () => {
    db.prepare("INSERT INTO plan_tasks (id, plan_id, title, status, verification_strategy) VALUES ('pt1','p1','x','completed','strategy')").run();
    db.prepare("INSERT INTO plan_audits (id, task_id, plan_id, verification_strategy, verdict, requested_at, attempt_number) VALUES ('a1','pt1','p1','strategy','pass',?,1)").run(new Date().toISOString());

    const res = await auditReset.resetPlanAudit({ db, planTaskId: 'pt1', reason: 'audit got it wrong on completeness', projectDir: tmpProjectDir, respawn: false });
    assert.equal(res.error, undefined);
    assert.equal(res.plan_task_id, 'pt1');
    assert.equal(res.plan_id, 'p1');
    assert.equal(res.new_status, 'pending_audit');
    const sc = db.prepare("SELECT * FROM state_changes WHERE entity_id = 'pt1'").get();
    assert.ok(sc, 'state_change row should be written');
    assert.equal(sc.field_name, 'status');
    assert.equal(sc.old_value, 'completed');
    assert.equal(sc.new_value, 'pending_audit');
    assert.equal(sc.changed_by, 'audit_reset');
  });

  it('plan_audits CHECK constraint accepts the prior verdict update (sets fail not reset)', async () => {
    db.prepare("INSERT INTO plan_tasks (id, plan_id, title, status, verification_strategy) VALUES ('pt1','p1','x','pending_audit','strategy')").run();
    db.prepare("INSERT INTO plan_audits (id, task_id, plan_id, verification_strategy, verdict, requested_at, attempt_number) VALUES ('a1','pt1','p1','strategy',NULL,?,1)").run(new Date().toISOString());
    // No throw → the CHECK constraint is honored (we set verdict='fail', not 'reset').
    const res = await auditReset.resetPlanAudit({ db, planTaskId: 'pt1', reason: 'auditor session crashed twice', projectDir: tmpProjectDir, respawn: false });
    assert.equal(res.error, undefined);
    const prior = db.prepare("SELECT verdict, failure_reason FROM plan_audits WHERE id = 'a1'").get();
    assert.equal(prior.verdict, 'fail');
    assert.match(prior.failure_reason, /Audit reset/);
  });
});
