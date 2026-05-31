/**
 * Tests for `handleQuotaCrashOnReap` in lib/quota-detector.js.
 *
 * Reproduces the 2026-05-27 incident where both quota-paused persistent tasks
 * stayed unrecoverable because (a) no `paused` event row was written and (b)
 * the bypass-request insert was silently rejected by the
 * `bypass_requests.category` CHECK constraint.
 *
 * Run with: node --test .claude/hooks/__tests__/quota-detector.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { handleQuotaCrashOnReap } = await import(
  path.resolve(__dirname, '..', 'lib', 'quota-detector.js')
);

// Mirrors persistent-tasks.db schema from packages/mcp-servers/src/persistent-task/server.ts
const PT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS persistent_tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    persistent_task_id TEXT NOT NULL REFERENCES persistent_tasks(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    details TEXT,
    created_at TEXT NOT NULL
  );
`;

// Mirrors bypass-requests.db schema from packages/mcp-servers/src/agent-tracker/server.ts
const BYPASS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS bypass_requests (
    id TEXT PRIMARY KEY,
    task_type TEXT NOT NULL,
    task_id TEXT NOT NULL,
    task_title TEXT NOT NULL,
    agent_id TEXT,
    session_queue_id TEXT,
    category TEXT NOT NULL DEFAULT 'general',
    summary TEXT NOT NULL,
    details TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    resolution_context TEXT,
    resolved_at TEXT,
    resolved_by TEXT DEFAULT 'cto',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (task_type IN ('persistent', 'todo')),
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
    CHECK (category IN ('destructive_operation', 'scope_change', 'ambiguous_requirement', 'resource_access', 'general'))
  );
`;

function createTestProject() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-detector-test-'));
  fs.mkdirSync(path.join(projectDir, '.claude', 'state'), { recursive: true });

  const ptDb = new Database(path.join(projectDir, '.claude', 'state', 'persistent-tasks.db'));
  ptDb.exec(PT_SCHEMA_SQL);
  ptDb.close();

  const bypassDb = new Database(path.join(projectDir, '.claude', 'state', 'bypass-requests.db'));
  bypassDb.exec(BYPASS_SCHEMA_SQL);
  bypassDb.close();

  return {
    projectDir,
    cleanup() {
      try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
    },
  };
}

function insertPersistentTask(projectDir, { id, status = 'active', metadata = null } = {}) {
  const db = new Database(path.join(projectDir, '.claude', 'state', 'persistent-tasks.db'));
  db.prepare("INSERT INTO persistent_tasks (id, title, status, metadata) VALUES (?, ?, ?, ?)")
    .run(id, 'Test task', status, metadata ? JSON.stringify(metadata) : null);
  db.close();
}

function readPtRow(projectDir, id) {
  const db = new Database(path.join(projectDir, '.claude', 'state', 'persistent-tasks.db'), { readonly: true });
  const row = db.prepare('SELECT * FROM persistent_tasks WHERE id = ?').get(id);
  db.close();
  return row;
}

function readEvents(projectDir, taskId) {
  const db = new Database(path.join(projectDir, '.claude', 'state', 'persistent-tasks.db'), { readonly: true });
  const rows = db.prepare('SELECT * FROM events WHERE persistent_task_id = ? ORDER BY created_at').all(taskId);
  db.close();
  return rows;
}

function readBypassRequests(projectDir) {
  const db = new Database(path.join(projectDir, '.claude', 'state', 'bypass-requests.db'), { readonly: true });
  const rows = db.prepare('SELECT * FROM bypass_requests').all();
  db.close();
  return rows;
}

describe('handleQuotaCrashOnReap', () => {
  let project;

  beforeEach(() => {
    project = createTestProject();
  });

  afterEach(() => {
    project.cleanup();
  });

  it('pauses the persistent task with quota_exhaustion metadata', () => {
    const taskId = `pt-${crypto.randomBytes(4).toString('hex')}`;
    insertPersistentTask(project.projectDir, { id: taskId, status: 'active' });

    const result = handleQuotaCrashOnReap({
      detection: { detected: true, resetHint: '4h 30m', rawText: 'You hit your limit' },
      metadata: { persistentTaskId: taskId, taskType: 'persistent' },
      agentId: 'agent-test1',
      projectDir: project.projectDir,
    });

    assert.equal(result.paused_persistent, taskId);

    const row = readPtRow(project.projectDir, taskId);
    assert.equal(row.status, 'paused');
    const meta = JSON.parse(row.metadata);
    assert.equal(meta.pause_reason, 'quota_exhaustion');
    assert.equal(meta.do_not_auto_resume, true);
    assert.equal(meta.quota_reset_hint, '4h 30m');
    assert.ok(meta.quota_detected_at, 'quota_detected_at timestamp set');
  });

  it("inserts a 'paused' event row (Bug B-1 — closes the persistent_stale_pause_resume gap)", () => {
    const taskId = `pt-${crypto.randomBytes(4).toString('hex')}`;
    insertPersistentTask(project.projectDir, { id: taskId, status: 'active' });

    handleQuotaCrashOnReap({
      detection: { detected: true, resetHint: '4h', rawText: 'You hit your limit' },
      metadata: { persistentTaskId: taskId, taskType: 'persistent' },
      agentId: 'agent-test2',
      projectDir: project.projectDir,
    });

    const events = readEvents(project.projectDir, taskId);
    assert.equal(events.length, 1, 'one paused event row inserted');
    assert.equal(events[0].event_type, 'paused');
    const details = JSON.parse(events[0].details);
    assert.equal(details.reason, 'quota_exhaustion');
    assert.equal(details.quota_reset_hint, '4h');
  });

  // Note: the bypass-request side-effect (and its dedup) was removed with the
  // CTO-bypass system. handleQuotaCrashOnReap now only pauses the persistent
  // task (covered by the two tests above); it no longer writes bypass-requests.db.

  it('returns gracefully when persistent task does not exist (best-effort)', () => {
    const result = handleQuotaCrashOnReap({
      detection: { detected: true, resetHint: '1h', rawText: 'limit' },
      metadata: { persistentTaskId: 'pt-does-not-exist', taskType: 'persistent' },
      agentId: 'agent-x',
      projectDir: project.projectDir,
    });
    // Task missing — no pause performed, and the call must not throw.
    assert.equal(result.paused_persistent, undefined);
  });

  it('is a no-op when detection.detected is false', () => {
    const taskId = `pt-${crypto.randomBytes(4).toString('hex')}`;
    insertPersistentTask(project.projectDir, { id: taskId, status: 'active' });

    const result = handleQuotaCrashOnReap({
      detection: { detected: false, resetHint: null, rawText: '' },
      metadata: { persistentTaskId: taskId, taskType: 'persistent' },
      agentId: 'agent-y',
      projectDir: project.projectDir,
    });

    assert.deepEqual(result, {});
    const row = readPtRow(project.projectDir, taskId);
    assert.equal(row.status, 'active', 'task status unchanged');
    assert.equal(readBypassRequests(project.projectDir).length, 0);
  });
});
