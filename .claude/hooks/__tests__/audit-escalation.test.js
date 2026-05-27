/**
 * Tests for lib/audit-escalation.js — wedged-audit detection and
 * deputy_reports filing. PR 4 (Fix 3).
 *
 * Run with: node --test .claude/hooks/__tests__/audit-escalation.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const {
  shouldEscalateAudit,
  resetAuditAndReport,
  getAuditAttemptStats,
  MAX_AUDIT_ATTEMPTS,
  MAX_AUDIT_WALL_MINUTES,
} = await import(path.resolve(__dirname, '..', 'lib', 'audit-escalation.js'));

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

const PT_SCHEMA = `
  CREATE TABLE persistent_tasks (
    id TEXT PRIMARY KEY,
    title TEXT,
    status TEXT NOT NULL DEFAULT 'draft'
  );
  CREATE TABLE pt_audits (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL DEFAULT 1,
    requested_at TEXT NOT NULL,
    verdict TEXT,
    failure_reason TEXT
  );
`;
const TODO_SCHEMA = `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    title TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
  );
  CREATE TABLE task_audits (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL DEFAULT 1,
    requested_at TEXT NOT NULL,
    verdict TEXT,
    failure_reason TEXT
  );
`;
const BYPASS_SCHEMA = `
  CREATE TABLE deputy_reports (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    task_type TEXT,
    task_id TEXT,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    acknowledged_at TEXT,
    resolved_at TEXT,
    resolution TEXT
  );
`;

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-escalation-'));
  fs.mkdirSync(path.join(dir, '.claude', 'state'), { recursive: true });
  const ptDb = new Database(path.join(dir, '.claude', 'state', 'persistent-tasks.db'));
  ptDb.exec(PT_SCHEMA); ptDb.close();
  const todoDb = new Database(path.join(dir, '.claude', 'todo.db'));
  todoDb.exec(TODO_SCHEMA); todoDb.close();
  const bypassDb = new Database(path.join(dir, '.claude', 'state', 'bypass-requests.db'));
  bypassDb.exec(BYPASS_SCHEMA); bypassDb.close();
  return dir;
}

function seedAuditAttempts(projectDir, taskType, taskId, count, firstAttemptIso) {
  const dbPath = taskType === 'todo'
    ? path.join(projectDir, '.claude', 'todo.db')
    : path.join(projectDir, '.claude', 'state', 'persistent-tasks.db');
  const table = taskType === 'todo' ? 'tasks' : 'persistent_tasks';
  const auditTable = taskType === 'todo' ? 'task_audits' : 'pt_audits';
  const db = new Database(dbPath);
  db.prepare(`INSERT OR REPLACE INTO ${table} (id, title, status) VALUES (?, ?, 'pending_audit')`).run(taskId, `Test ${taskId}`);
  for (let i = 1; i <= count; i++) {
    // Spread requested_at timestamps if firstAttemptIso provided
    const reqAt = firstAttemptIso && i === 1
      ? firstAttemptIso
      : new Date(Date.now() - (count - i) * 60_000).toISOString();
    db.prepare(`
      INSERT INTO ${auditTable} (id, task_id, attempt_number, requested_at, verdict)
      VALUES (?, ?, ?, ?, NULL)
    `).run(`audit-${i}-${taskId}`, taskId, i, reqAt);
  }
  db.close();
}

let projectDir;
beforeEach(() => { projectDir = makeProject(); });
afterEach(() => { fs.rmSync(projectDir, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// getAuditAttemptStats
// ---------------------------------------------------------------------------

describe('getAuditAttemptStats', () => {
  it('returns {attempts: 0} when no audit rows exist', () => {
    const stats = getAuditAttemptStats({ taskType: 'persistent', taskId: 'no-such-task', projectDir });
    assert.ok(stats);
    assert.equal(stats.attempts, 0);
    assert.equal(stats.firstAttemptAt, null);
  });

  it('returns the max attempt_number across rows', () => {
    seedAuditAttempts(projectDir, 'persistent', 'pt-1', 3);
    const stats = getAuditAttemptStats({ taskType: 'persistent', taskId: 'pt-1', projectDir });
    assert.equal(stats.attempts, 3);
    assert.ok(stats.firstAttemptAt);
    assert.ok(stats.lastAttemptAt);
  });

  it('works for todo task type', () => {
    seedAuditAttempts(projectDir, 'todo', 't-1', 2);
    const stats = getAuditAttemptStats({ taskType: 'todo', taskId: 't-1', projectDir });
    assert.equal(stats.attempts, 2);
  });

  it('returns null when DB is missing', () => {
    fs.rmSync(path.join(projectDir, '.claude', 'state', 'persistent-tasks.db'));
    const stats = getAuditAttemptStats({ taskType: 'persistent', taskId: 'x', projectDir });
    assert.equal(stats, null);
  });
});

// ---------------------------------------------------------------------------
// shouldEscalateAudit
// ---------------------------------------------------------------------------

describe('shouldEscalateAudit', () => {
  it('does NOT escalate at 0 attempts', () => {
    const d = shouldEscalateAudit({ taskType: 'persistent', taskId: 'pt-x', projectDir });
    assert.equal(d.escalate, false);
  });

  it('does NOT escalate at 1-2 attempts (under threshold)', () => {
    seedAuditAttempts(projectDir, 'persistent', 'pt-1', 2);
    const d = shouldEscalateAudit({ taskType: 'persistent', taskId: 'pt-1', projectDir });
    assert.equal(d.escalate, false);
    assert.equal(d.attempts, 2);
  });

  it('escalates at MAX_AUDIT_ATTEMPTS exactly', () => {
    seedAuditAttempts(projectDir, 'persistent', 'pt-1', MAX_AUDIT_ATTEMPTS);
    const d = shouldEscalateAudit({ taskType: 'persistent', taskId: 'pt-1', projectDir });
    assert.equal(d.escalate, true);
    assert.match(d.reason, /attempts=3/);
  });

  it('escalates past wall-time threshold even with low attempt count', () => {
    const oldDate = new Date(Date.now() - (MAX_AUDIT_WALL_MINUTES + 5) * 60_000).toISOString();
    seedAuditAttempts(projectDir, 'persistent', 'pt-1', 1, oldDate);
    const d = shouldEscalateAudit({ taskType: 'persistent', taskId: 'pt-1', projectDir });
    assert.equal(d.escalate, true);
    assert.match(d.reason, /age=.* >= 45min/);
  });
});

// ---------------------------------------------------------------------------
// resetAuditAndReport
// ---------------------------------------------------------------------------

describe('resetAuditAndReport', () => {
  it('resets the persistent task to in_progress and inserts a deputy_reports row', () => {
    seedAuditAttempts(projectDir, 'persistent', 'pt-1', 3);
    const result = resetAuditAndReport({
      taskType: 'persistent',
      taskId: 'pt-1',
      projectDir,
      payload: { test: 'data', attempts: 3 },
    });
    assert.equal(result.reset, true);
    assert.ok(result.reportId);
    assert.match(result.reportId, /^dr-/);

    // Verify task status updated
    const ptDb = new Database(path.join(projectDir, '.claude', 'state', 'persistent-tasks.db'), { readonly: true });
    const task = ptDb.prepare('SELECT status FROM persistent_tasks WHERE id = ?').get('pt-1');
    ptDb.close();
    assert.equal(task.status, 'in_progress');

    // Verify deputy_reports row
    const bypassDb = new Database(path.join(projectDir, '.claude', 'state', 'bypass-requests.db'), { readonly: true });
    const report = bypassDb.prepare("SELECT * FROM deputy_reports WHERE task_id = ?").get('pt-1');
    bypassDb.close();
    assert.ok(report);
    assert.equal(report.kind, 'wedged_audit');
    assert.equal(report.status, 'open');
    const payload = JSON.parse(report.payload);
    assert.equal(payload.test, 'data');
    assert.equal(payload.attempts, 3);
  });

  it('marks the latest pending audit row as failed', () => {
    seedAuditAttempts(projectDir, 'persistent', 'pt-1', 3);
    resetAuditAndReport({
      taskType: 'persistent', taskId: 'pt-1', projectDir, payload: {},
    });
    const ptDb = new Database(path.join(projectDir, '.claude', 'state', 'persistent-tasks.db'), { readonly: true });
    const audit = ptDb.prepare("SELECT verdict, failure_reason FROM pt_audits WHERE attempt_number = 3").get();
    ptDb.close();
    assert.equal(audit.verdict, 'fail');
    assert.match(audit.failure_reason, /escalated/i);
  });

  it('is idempotent — second call does not create duplicate report', () => {
    seedAuditAttempts(projectDir, 'persistent', 'pt-1', 3);
    const first = resetAuditAndReport({ taskType: 'persistent', taskId: 'pt-1', projectDir, payload: {} });
    const second = resetAuditAndReport({ taskType: 'persistent', taskId: 'pt-1', projectDir, payload: {} });
    assert.equal(first.reportId, second.reportId, 'second call should return existing report id');
    const bypassDb = new Database(path.join(projectDir, '.claude', 'state', 'bypass-requests.db'), { readonly: true });
    const count = bypassDb.prepare("SELECT COUNT(*) AS c FROM deputy_reports WHERE task_id = ? AND kind = 'wedged_audit'").get('pt-1').c;
    bypassDb.close();
    assert.equal(count, 1);
  });

  it('works for todo task type', () => {
    seedAuditAttempts(projectDir, 'todo', 't-1', 3);
    const result = resetAuditAndReport({ taskType: 'todo', taskId: 't-1', projectDir, payload: {} });
    assert.equal(result.reset, true);
    const todoDb = new Database(path.join(projectDir, '.claude', 'todo.db'), { readonly: true });
    const task = todoDb.prepare('SELECT status FROM tasks WHERE id = ?').get('t-1');
    todoDb.close();
    assert.equal(task.status, 'in_progress');
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('escalation thresholds', () => {
  it('MAX_AUDIT_ATTEMPTS is 3', () => {
    assert.equal(MAX_AUDIT_ATTEMPTS, 3);
  });
  it('MAX_AUDIT_WALL_MINUTES is 45', () => {
    assert.equal(MAX_AUDIT_WALL_MINUTES, 45);
  });
});
