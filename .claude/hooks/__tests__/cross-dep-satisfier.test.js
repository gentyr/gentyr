/**
 * Tests for .claude/hooks/lib/cross-dep-satisfier.js
 *
 * Validates:
 *  - satisfyCompletedBlocker marks matching active deps as 'satisfied' and
 *    returns the unblocked entities.
 *  - cascadeUnblock auto-activates draft persistent tasks whose deps are met.
 *  - cascadeUnblock promotes blocked plan_tasks to 'pending'.
 *  - Both functions fail-open when DBs are missing.
 *
 * Each test owns a temporary CLAUDE_PROJECT_DIR with isolated SQLite files.
 *
 * Run with: node --test .claude/hooks/__tests__/cross-dep-satisfier.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

const TEST_FILE_DIR = path.dirname(new URL(import.meta.url).pathname);

let tmpDir;
let originalProjectDir;

function makeWorkstreamDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE queue_dependencies (
      id TEXT PRIMARY KEY,
      blocked_queue_id TEXT,
      blocked_task_id TEXT NOT NULL,
      blocked_entity_type TEXT NOT NULL DEFAULT 'todo' CHECK (blocked_entity_type IN ('todo','persistent','plan_task')),
      blocker_queue_id TEXT,
      blocker_task_id TEXT NOT NULL,
      blocker_entity_type TEXT NOT NULL DEFAULT 'todo' CHECK (blocker_entity_type IN ('todo','persistent','plan_task','plan')),
      status TEXT NOT NULL DEFAULT 'active',
      created_by TEXT NOT NULL,
      reasoning TEXT NOT NULL,
      pause_action TEXT,
      created_at TEXT NOT NULL,
      satisfied_at TEXT,
      UNIQUE(blocked_entity_type, blocked_task_id, blocker_entity_type, blocker_task_id)
    );
    CREATE TABLE workstream_changes (
      id TEXT PRIMARY KEY,
      change_type TEXT NOT NULL,
      queue_id TEXT,
      task_id TEXT,
      details TEXT NOT NULL,
      reasoning TEXT NOT NULL,
      agent_id TEXT,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

function makePersistentTasksDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE persistent_tasks (
      id TEXT PRIMARY KEY,
      title TEXT,
      status TEXT NOT NULL,
      activated_at TEXT,
      metadata TEXT
    );
    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      persistent_task_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

function makePlansDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE plans (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE plan_tasks (
      id TEXT PRIMARY KEY,
      phase_id TEXT,
      plan_id TEXT,
      status TEXT NOT NULL
    );
  `);
  return db;
}

function newDepId() {
  return `dep-${crypto.randomBytes(4).toString('hex')}`;
}

function insertDep(wsDb, { blocker, blocked, status = 'active' }) {
  const id = newDepId();
  const ts = new Date().toISOString();
  wsDb
    .prepare(
      'INSERT INTO queue_dependencies (id, blocked_task_id, blocked_entity_type, blocker_task_id, blocker_entity_type, status, created_by, reasoning, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(id, blocked.id, blocked.type, blocker.id, blocker.type, status, 'test', 'test reasoning', ts);
  return id;
}

describe('cross-dep-satisfier.js', () => {
  let satisfier;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-dep-test-'));
    fs.mkdirSync(path.join(tmpDir, '.claude', 'state'), { recursive: true });
    originalProjectDir = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    // Force a fresh import so the module re-evaluates CLAUDE_PROJECT_DIR.
    const modulePath = path.join(TEST_FILE_DIR, '..', 'lib', 'cross-dep-satisfier.js');
    satisfier = await import(`${modulePath}?cachebust=${Date.now()}-${Math.random()}`);
  });

  afterEach(() => {
    if (originalProjectDir === undefined) {
      delete process.env.CLAUDE_PROJECT_DIR;
    } else {
      process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fails open when workstream.db is missing', () => {
    const result = satisfier.satisfyCompletedBlocker({ entity_type: 'todo', entity_id: 't1' });
    assert.deepStrictEqual(result, { satisfied: 0, unblocked: [] });
  });

  it('marks deps satisfied where this entity is the blocker', () => {
    const wsDb = makeWorkstreamDb(path.join(tmpDir, '.claude', 'state', 'workstream.db'));
    insertDep(wsDb, {
      blocker: { type: 'persistent', id: 'p-blocker' },
      blocked: { type: 'persistent', id: 'p-waiter' },
    });
    insertDep(wsDb, {
      blocker: { type: 'persistent', id: 'p-other' },
      blocked: { type: 'persistent', id: 'p-waiter' },
    });
    wsDb.close();

    const result = satisfier.satisfyCompletedBlocker({
      entity_type: 'persistent',
      entity_id: 'p-blocker',
    });
    assert.strictEqual(result.satisfied, 1);
    assert.strictEqual(result.unblocked.length, 1);
    assert.deepStrictEqual(result.unblocked[0], {
      entity_type: 'persistent',
      entity_id: 'p-waiter',
      dep_id: result.unblocked[0].dep_id,
    });

    // Verify the OTHER dep is still active.
    const reopen = new Database(path.join(tmpDir, '.claude', 'state', 'workstream.db'), { readonly: true });
    const active = reopen.prepare("SELECT COUNT(*) AS n FROM queue_dependencies WHERE status = 'active'").get();
    assert.strictEqual(active.n, 1);
    reopen.close();
  });

  it('cascadeUnblock auto-activates draft persistent tasks whose deps are all met', async () => {
    const wsDb = makeWorkstreamDb(path.join(tmpDir, '.claude', 'state', 'workstream.db'));
    const ptDb = makePersistentTasksDb(path.join(tmpDir, '.claude', 'state', 'persistent-tasks.db'));

    // Single-blocker scenario — completing it should fully unblock the waiter.
    ptDb
      .prepare("INSERT INTO persistent_tasks (id, title, status) VALUES (?, ?, 'draft')")
      .run('p-waiter', 'Downstream task');
    insertDep(wsDb, {
      blocker: { type: 'persistent', id: 'p-blocker' },
      blocked: { type: 'persistent', id: 'p-waiter' },
    });
    ptDb.close();
    wsDb.close();

    const { unblocked } = satisfier.satisfyCompletedBlocker({
      entity_type: 'persistent',
      entity_id: 'p-blocker',
    });
    const actions = await satisfier.cascadeUnblock(unblocked);

    assert.deepStrictEqual(actions.persistentActivations, ['p-waiter']);

    const checkDb = new Database(path.join(tmpDir, '.claude', 'state', 'persistent-tasks.db'), { readonly: true });
    const row = checkDb.prepare('SELECT status, activated_at FROM persistent_tasks WHERE id = ?').get('p-waiter');
    checkDb.close();
    assert.strictEqual(row.status, 'active');
    assert.ok(row.activated_at);
  });

  it('cascadeUnblock leaves partially-blocked entities alone', async () => {
    const wsDb = makeWorkstreamDb(path.join(tmpDir, '.claude', 'state', 'workstream.db'));
    const ptDb = makePersistentTasksDb(path.join(tmpDir, '.claude', 'state', 'persistent-tasks.db'));

    ptDb
      .prepare("INSERT INTO persistent_tasks (id, title, status) VALUES (?, ?, 'draft')")
      .run('p-waiter', 'Downstream');
    insertDep(wsDb, {
      blocker: { type: 'persistent', id: 'p-blocker-1' },
      blocked: { type: 'persistent', id: 'p-waiter' },
    });
    insertDep(wsDb, {
      blocker: { type: 'persistent', id: 'p-blocker-2' },
      blocked: { type: 'persistent', id: 'p-waiter' },
    });
    ptDb.close();
    wsDb.close();

    const { unblocked } = satisfier.satisfyCompletedBlocker({
      entity_type: 'persistent',
      entity_id: 'p-blocker-1',
    });
    const actions = await satisfier.cascadeUnblock(unblocked);

    assert.deepStrictEqual(actions.persistentActivations, []);
    const checkDb = new Database(path.join(tmpDir, '.claude', 'state', 'persistent-tasks.db'), { readonly: true });
    const row = checkDb.prepare('SELECT status FROM persistent_tasks WHERE id = ?').get('p-waiter');
    checkDb.close();
    assert.strictEqual(row.status, 'draft');
  });

  it('cascadeUnblock promotes blocked plan_tasks to pending when deps clear', async () => {
    const wsDb = makeWorkstreamDb(path.join(tmpDir, '.claude', 'state', 'workstream.db'));
    const plansDb = makePlansDb(path.join(tmpDir, '.claude', 'state', 'plans.db'));

    plansDb
      .prepare("INSERT INTO plan_tasks (id, status) VALUES (?, 'blocked')")
      .run('pt-waiter');
    insertDep(wsDb, {
      blocker: { type: 'todo', id: 't-blocker' },
      blocked: { type: 'plan_task', id: 'pt-waiter' },
    });
    plansDb.close();
    wsDb.close();

    const { unblocked } = satisfier.satisfyCompletedBlocker({
      entity_type: 'todo',
      entity_id: 't-blocker',
    });
    const actions = await satisfier.cascadeUnblock(unblocked);

    assert.deepStrictEqual(actions.planTaskUnblocks, ['pt-waiter']);
    const checkDb = new Database(path.join(tmpDir, '.claude', 'state', 'plans.db'), { readonly: true });
    const row = checkDb.prepare('SELECT status FROM plan_tasks WHERE id = ?').get('pt-waiter');
    checkDb.close();
    assert.strictEqual(row.status, 'pending');
  });

  it('handles plan-as-blocker satisfaction (whole-plan completion)', () => {
    const wsDb = makeWorkstreamDb(path.join(tmpDir, '.claude', 'state', 'workstream.db'));
    insertDep(wsDb, {
      blocker: { type: 'plan', id: 'plan-abc' },
      blocked: { type: 'persistent', id: 'p-waits-for-plan' },
    });
    wsDb.close();

    const result = satisfier.satisfyCompletedBlocker({
      entity_type: 'plan',
      entity_id: 'plan-abc',
    });
    assert.strictEqual(result.satisfied, 1);
  });
});
