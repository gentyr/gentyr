/**
 * Tests for session-queue.js Step 2.1 — TTL kill must reset the linked todo
 * task back to `pending` so the work can be revived.
 *
 * Closes the 2026-05-27 incident where a code-writer child of a quota-paused
 * persistent task was TTL-killed at 13:48:58 and sat orphaned in
 * `status='in_progress'` for 1h 16m. The PID-death reap path
 * (session-reaper.js:642) does this reset; the running-TTL kill path did not.
 *
 * Uses two verification strategies:
 *   A. Source-code structural check — the new behavior must be wired into
 *      Step 2.1 of session-queue.js.
 *   B. SQL behavior check — the reset query mirrors session-reaper.js's
 *      pending-reset and is idempotent (only fires when status='in_progress').
 *
 * Run with: node --test .claude/hooks/__tests__/session-queue-step2-1-ttl-reset.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SESSION_QUEUE_PATH = path.resolve(__dirname, '..', 'lib', 'session-queue.js');

let sourceCode;
before(() => {
  sourceCode = fs.readFileSync(SESSION_QUEUE_PATH, 'utf8');
});

function getStep21Body() {
  const marker = 'Step 2.1: Kill RUNNING sessions past their TTL';
  const start = sourceCode.indexOf(marker);
  assert.ok(start >= 0, 'Step 2.1 marker must exist');
  const end = sourceCode.indexOf('Step 2.5', start);
  assert.ok(end > start, 'Step 2.5 must follow Step 2.1');
  return sourceCode.slice(start, end);
}

describe('Step 2.1 — structural checks', () => {
  it('SELECT must include metadata column for taskId lookup', () => {
    const body = getStep21Body();
    assert.match(body, /SELECT id, agent_id, pid, agent_type, lane, title, metadata FROM queue_items/);
  });

  it('audit-lane items are skipped (their tasks use pending_audit recovery)', () => {
    const body = getStep21Body();
    assert.match(body, /row\.lane !== 'audit'/);
  });

  it("resets linked todo task from 'in_progress' to 'pending'", () => {
    const body = getStep21Body();
    assert.match(body, /UPDATE tasks SET status = 'pending'/);
    assert.match(body, /WHERE id = \? AND status = 'in_progress'/);
  });

  it("clears started_at and started_timestamp on reset (matches session-reaper.js:642)", () => {
    const body = getStep21Body();
    assert.match(body, /started_at = NULL/);
    assert.match(body, /started_timestamp = NULL/);
  });

  it("emits 'task_reset_on_ttl_kill' audit event for observability", () => {
    const body = getStep21Body();
    assert.match(body, /task_reset_on_ttl_kill/);
  });

  it('parses metadata JSON defensively (try/catch)', () => {
    const body = getStep21Body();
    assert.match(body, /try \{ metadata = row\.metadata \? JSON\.parse/);
  });
});

// ----------------------------------------------------------------------------
// SQL behavior check — exercise the reset query directly against a real todo.db
// ----------------------------------------------------------------------------

const TODO_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    started_at TEXT,
    started_timestamp INTEGER,
    completed_at TEXT
  );
`;

function createTodoDb() {
  const dbPath = path.join(os.tmpdir(), `todo-step21-${Date.now()}-${crypto.randomBytes(2).toString('hex')}.db`);
  const db = new Database(dbPath);
  db.exec(TODO_SCHEMA_SQL);
  return {
    db,
    cleanup() {
      try { db.close(); } catch { /* non-fatal */ }
      for (const ext of ['', '-shm', '-wal']) {
        const f = dbPath + ext;
        if (fs.existsSync(f)) try { fs.unlinkSync(f); } catch { /* non-fatal */ }
      }
    },
  };
}

const RESET_SQL = "UPDATE tasks SET status = 'pending', started_at = NULL, started_timestamp = NULL WHERE id = ? AND status = 'in_progress'";

describe('Step 2.1 reset SQL — behavior', () => {
  it("resets a task in 'in_progress' back to 'pending' and clears timestamps", () => {
    const { db, cleanup } = createTodoDb();
    try {
      db.prepare("INSERT INTO tasks (id, title, status, started_at, started_timestamp) VALUES (?, ?, 'in_progress', ?, ?)")
        .run('t1', 'work', '2026-05-27T13:18:55Z', Date.now());

      const res = db.prepare(RESET_SQL).run('t1');
      assert.equal(res.changes, 1);

      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get('t1');
      assert.equal(row.status, 'pending');
      assert.equal(row.started_at, null);
      assert.equal(row.started_timestamp, null);
    } finally {
      cleanup();
    }
  });

  it("does NOT touch a task that is already 'pending' (idempotent)", () => {
    const { db, cleanup } = createTodoDb();
    try {
      db.prepare("INSERT INTO tasks (id, title, status) VALUES (?, ?, 'pending')").run('t2', 'work');
      const res = db.prepare(RESET_SQL).run('t2');
      assert.equal(res.changes, 0);
    } finally {
      cleanup();
    }
  });

  it("does NOT touch a 'completed' task (must not resurrect work)", () => {
    const { db, cleanup } = createTodoDb();
    try {
      db.prepare("INSERT INTO tasks (id, title, status, completed_at) VALUES (?, ?, 'completed', ?)")
        .run('t3', 'work', '2026-05-27T14:00:00Z');
      const res = db.prepare(RESET_SQL).run('t3');
      assert.equal(res.changes, 0);
      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get('t3');
      assert.equal(row.status, 'completed');
    } finally {
      cleanup();
    }
  });

  it('no-op when the task id does not exist', () => {
    const { db, cleanup } = createTodoDb();
    try {
      const res = db.prepare(RESET_SQL).run('nonexistent');
      assert.equal(res.changes, 0);
    } finally {
      cleanup();
    }
  });
});
