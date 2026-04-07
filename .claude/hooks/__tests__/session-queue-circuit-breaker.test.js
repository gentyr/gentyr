/**
 * Tests for the circuit breaker and session queue resilience changes in session-queue.js.
 *
 * Covers:
 *   1. revival_events table creation (schema + index)
 *   2. DB-backed rate limiter (cold-start path after process restart)
 *   3. Dedup includes 'spawning' status (race-condition fix)
 *   4. Circuit breaker threshold: 3 hard revivals per 10 minutes
 *   5. Revival event persistence (survives DB close/reopen)
 *   6. Source-code structural verification
 *
 * These tests create real SQLite databases in /tmp. No mocks — the logic is
 * exercised by running the same SQL queries that session-queue.js uses, against
 * a database that mirrors the production schema.
 *
 * Run with: node --test .claude/hooks/__tests__/session-queue-circuit-breaker.test.js
 */

import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

// ============================================================================
// Schema — mirrored verbatim from session-queue.js getDb()
// ============================================================================

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS queue_items (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'queued',
    priority TEXT NOT NULL DEFAULT 'normal',
    lane TEXT NOT NULL DEFAULT 'standard',
    spawn_type TEXT NOT NULL DEFAULT 'fresh',
    title TEXT NOT NULL,
    agent_type TEXT NOT NULL,
    hook_type TEXT NOT NULL,
    tag_context TEXT NOT NULL,
    prompt TEXT,
    model TEXT,
    cwd TEXT,
    mcp_config TEXT,
    resume_session_id TEXT,
    extra_args TEXT,
    extra_env TEXT,
    project_dir TEXT NOT NULL,
    worktree_path TEXT,
    metadata TEXT,
    source TEXT NOT NULL,
    agent_id TEXT,
    pid INTEGER,
    enqueued_at TEXT NOT NULL DEFAULT (datetime('now')),
    spawned_at TEXT,
    completed_at TEXT,
    error TEXT,
    expires_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_queue_status ON queue_items(status);
  CREATE INDEX IF NOT EXISTS idx_queue_priority ON queue_items(priority, lane, enqueued_at);

  CREATE TABLE IF NOT EXISTS queue_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS revival_events (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_revival_task_time ON revival_events(task_id, created_at);
`;

// ============================================================================
// Helpers
// ============================================================================

function generateId() {
  return `test-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Open a fresh temp database with the production schema applied.
 * Returns { db, dbPath, cleanup }.
 */
function createTestDb(prefix = 'sq-circuit-breaker-test') {
  const dbPath = path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${crypto.randomBytes(2).toString('hex')}.db`
  );
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA_SQL);

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

/**
 * Insert a revival_events row.
 * offsetMinutes < 0  => row is that many minutes in the past.
 * offsetMinutes === 0 => uses SQLite datetime('now') default.
 */
function insertRevivalEvent(db, { taskId, reason = 'hard_revival', offsetMinutes = 0 }) {
  const id = generateId();
  if (offsetMinutes === 0) {
    db.prepare('INSERT INTO revival_events (id, task_id, reason) VALUES (?, ?, ?)')
      .run(id, taskId, reason);
  } else {
    db.prepare(
      `INSERT INTO revival_events (id, task_id, reason, created_at) VALUES (?, ?, ?, datetime('now', '${offsetMinutes} minutes'))`
    ).run(id, taskId, reason);
  }
  return id;
}

/**
 * Count hard revivals in the last 10 minutes for a task.
 * This is the exact DB query used by requeueDeadPersistentMonitor() cold-start path.
 */
function countRecentHardRevivals(db, taskId) {
  const row = db.prepare(
    "SELECT COUNT(*) as cnt FROM revival_events WHERE task_id = ? AND created_at > datetime('now', '-10 minutes') AND reason != 'stale_heartbeat'"
  ).get(taskId);
  return row?.cnt || 0;
}

/**
 * Insert a queue_items row with the given status, lane, and optional metadata.
 * Supports an explicit enqueued_at for testing the time-window circuit breaker.
 */
function insertQueueItem(db, { id, status = 'queued', lane = 'standard', metadata = null, enqueued_at = null }) {
  if (enqueued_at) {
    db.prepare(`
      INSERT INTO queue_items
        (id, status, lane, spawn_type, title, agent_type, hook_type, tag_context, project_dir, source, enqueued_at)
      VALUES
        (?, ?, ?, 'fresh', 'Test item', 'persistent-monitor', 'persistent-monitor', 'test-ctx', '/tmp/test', 'test', ?)
    `).run(id, status, lane, enqueued_at);
  } else {
    db.prepare(`
      INSERT INTO queue_items
        (id, status, lane, spawn_type, title, agent_type, hook_type, tag_context, project_dir, source)
      VALUES
        (?, ?, ?, 'fresh', 'Test item', 'persistent-monitor', 'persistent-monitor', 'test-ctx', '/tmp/test', 'test')
    `).run(id, status, lane);
  }
  if (metadata) {
    db.prepare('UPDATE queue_items SET metadata = ? WHERE id = ?')
      .run(JSON.stringify(metadata), id);
  }
}

/**
 * Count recent circuit-breaker hits via the queue_items query used in
 * requeueDeadPersistentMonitor() "Crash-loop circuit breaker" block.
 */
function countCircuitBreakerHits(db, taskId) {
  const row = db.prepare(
    "SELECT COUNT(*) as cnt FROM queue_items WHERE lane = 'persistent' AND json_extract(metadata, '$.persistentTaskId') = ? AND enqueued_at > datetime('now', '-10 minutes') AND COALESCE(json_extract(metadata, '$.revivalReason'), '') != 'heartbeat_stale_revival'"
  ).get(taskId);
  return row?.cnt || 0;
}

// ============================================================================
// Test Group 1: revival_events table creation
// ============================================================================

describe('revival_events table schema', () => {
  let ctx;

  beforeEach(() => { ctx = createTestDb('schema-test'); });
  afterEach(() => { ctx.cleanup(); });

  it('revival_events table exists with exactly the 4 expected columns', () => {
    const cols = ctx.db.prepare('PRAGMA table_info(revival_events)').all();
    const names = cols.map(c => c.name);

    assert.ok(names.includes('id'), 'column id must exist');
    assert.ok(names.includes('task_id'), 'column task_id must exist');
    assert.ok(names.includes('reason'), 'column reason must exist');
    assert.ok(names.includes('created_at'), 'column created_at must exist');
    assert.strictEqual(names.length, 4, 'revival_events must have exactly 4 columns');
  });

  it('idx_revival_task_time index exists on revival_events', () => {
    const indexes = ctx.db.prepare('PRAGMA index_list(revival_events)').all();
    const indexNames = indexes.map(i => i.name);

    assert.ok(
      indexNames.includes('idx_revival_task_time'),
      `idx_revival_task_time must exist; found: [${indexNames.join(', ')}]`
    );
  });

  it('id is the primary key', () => {
    const cols = ctx.db.prepare('PRAGMA table_info(revival_events)').all();
    const idCol = cols.find(c => c.name === 'id');
    assert.ok(idCol, 'id column must exist');
    assert.strictEqual(idCol.pk, 1, 'id must be the primary key (pk=1)');
  });

  it('created_at defaults to datetime(now) in SQLite space-separated format', () => {
    ctx.db.prepare('INSERT INTO revival_events (id, task_id, reason) VALUES (?, ?, ?)')
      .run('schema-test-id', 'task-x', 'hard_revival');
    const row = ctx.db.prepare("SELECT created_at FROM revival_events WHERE id = 'schema-test-id'").get();

    assert.ok(row, 'inserted row must exist');
    assert.ok(row.created_at, 'created_at must be non-null');
    // SQLite datetime('now') format: "YYYY-MM-DD HH:MM:SS" (space separator, no Z)
    assert.match(
      row.created_at,
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
      `created_at must match SQLite datetime format "YYYY-MM-DD HH:MM:SS", got: ${row.created_at}`
    );
  });
});

// ============================================================================
// Test Group 2: DB-backed rate limiter (cold-start path)
// ============================================================================

describe('DB-backed rate limiter — cold-start path (revival_events)', () => {
  let ctx;
  const TASK_ID = 'persistent-task-rate-limiter-test';

  beforeEach(() => { ctx = createTestDb('rate-limiter-test'); });
  afterEach(() => { ctx.cleanup(); });

  it('3 hard revival_events within last 10 minutes triggers rate limit (count >= 3)', () => {
    insertRevivalEvent(ctx.db, { taskId: TASK_ID, reason: 'hard_revival', offsetMinutes: -1 });
    insertRevivalEvent(ctx.db, { taskId: TASK_ID, reason: 'hard_revival', offsetMinutes: -2 });
    insertRevivalEvent(ctx.db, { taskId: TASK_ID, reason: 'hard_revival', offsetMinutes: -3 });

    const count = countRecentHardRevivals(ctx.db, TASK_ID);
    assert.ok(count >= 3, `rate limiter must trip at 3 hard revivals; got count=${count}`);
  });

  it('stale_heartbeat events are excluded from the rate limit count', () => {
    insertRevivalEvent(ctx.db, { taskId: TASK_ID, reason: 'stale_heartbeat', offsetMinutes: -1 });
    insertRevivalEvent(ctx.db, { taskId: TASK_ID, reason: 'stale_heartbeat', offsetMinutes: -2 });
    insertRevivalEvent(ctx.db, { taskId: TASK_ID, reason: 'stale_heartbeat', offsetMinutes: -3 });

    const count = countRecentHardRevivals(ctx.db, TASK_ID);
    assert.strictEqual(count, 0, 'stale_heartbeat events must not count toward the hard revival rate limit');
  });

  it('events older than 10 minutes are excluded from the count', () => {
    insertRevivalEvent(ctx.db, { taskId: TASK_ID, reason: 'hard_revival', offsetMinutes: -11 });
    insertRevivalEvent(ctx.db, { taskId: TASK_ID, reason: 'hard_revival', offsetMinutes: -15 });
    insertRevivalEvent(ctx.db, { taskId: TASK_ID, reason: 'hard_revival', offsetMinutes: -20 });

    const count = countRecentHardRevivals(ctx.db, TASK_ID);
    assert.strictEqual(count, 0, 'events older than 10 minutes must not count toward the rate limit');
  });

  it('2 hard revivals within last 10 minutes does NOT trigger rate limit', () => {
    insertRevivalEvent(ctx.db, { taskId: TASK_ID, reason: 'hard_revival', offsetMinutes: -1 });
    insertRevivalEvent(ctx.db, { taskId: TASK_ID, reason: 'hard_revival', offsetMinutes: -2 });

    const count = countRecentHardRevivals(ctx.db, TASK_ID);
    assert.ok(count < 3, `rate limiter must NOT trip at 2 hard revivals; got count=${count}`);
  });

  it('mixed stale_heartbeat and hard_revival: only hard_revival events count', () => {
    insertRevivalEvent(ctx.db, { taskId: TASK_ID, reason: 'stale_heartbeat', offsetMinutes: -1 });
    insertRevivalEvent(ctx.db, { taskId: TASK_ID, reason: 'stale_heartbeat', offsetMinutes: -2 });
    insertRevivalEvent(ctx.db, { taskId: TASK_ID, reason: 'hard_revival', offsetMinutes: -3 });

    const count = countRecentHardRevivals(ctx.db, TASK_ID);
    assert.strictEqual(count, 1, 'only hard_revival events should count; stale_heartbeat must be excluded');
  });

  it('rate limit is per task_id — different task IDs are independent', () => {
    const OTHER_TASK = 'different-task-id';
    insertRevivalEvent(ctx.db, { taskId: OTHER_TASK, reason: 'hard_revival', offsetMinutes: -1 });
    insertRevivalEvent(ctx.db, { taskId: OTHER_TASK, reason: 'hard_revival', offsetMinutes: -2 });
    insertRevivalEvent(ctx.db, { taskId: OTHER_TASK, reason: 'hard_revival', offsetMinutes: -3 });

    const countForTask = countRecentHardRevivals(ctx.db, TASK_ID);
    assert.strictEqual(countForTask, 0, 'revivals for OTHER_TASK must not affect TASK_ID rate limit');

    const countForOther = countRecentHardRevivals(ctx.db, OTHER_TASK);
    assert.ok(countForOther >= 3, `OTHER_TASK should have 3 hard revivals; got ${countForOther}`);
  });
});

// ============================================================================
// Test Group 3: Dedup includes 'spawning' status
// ============================================================================

describe("Dedup check includes 'spawning' status (race-condition fix)", () => {
  let ctx;

  beforeEach(() => { ctx = createTestDb('dedup-spawning-test'); });
  afterEach(() => { ctx.cleanup(); });

  it("finds a 'spawning' item in the persistent monitor dedup query", () => {
    const taskId = 'persistent-task-spawning-dedup';
    insertQueueItem(ctx.db, {
      id: generateId(),
      status: 'spawning',
      lane: 'persistent',
      metadata: { persistentTaskId: taskId },
    });

    // Exact dedup query from requeueDeadPersistentMonitor()
    const result = ctx.db.prepare(
      "SELECT COUNT(*) as cnt FROM queue_items WHERE lane = 'persistent' AND status IN ('queued', 'running', 'spawning') AND json_extract(metadata, '$.persistentTaskId') = ?"
    ).get(taskId);

    assert.ok(result.cnt > 0, "'spawning' item must be found by dedup query to prevent race condition");
  });

  it("finds a 'queued' item in the persistent monitor dedup query", () => {
    const taskId = 'persistent-task-queued-dedup';
    insertQueueItem(ctx.db, {
      id: generateId(),
      status: 'queued',
      lane: 'persistent',
      metadata: { persistentTaskId: taskId },
    });

    const result = ctx.db.prepare(
      "SELECT COUNT(*) as cnt FROM queue_items WHERE lane = 'persistent' AND status IN ('queued', 'running', 'spawning') AND json_extract(metadata, '$.persistentTaskId') = ?"
    ).get(taskId);

    assert.ok(result.cnt > 0, "'queued' item must be found by dedup query");
  });

  it("finds a 'running' item in the persistent monitor dedup query", () => {
    const taskId = 'persistent-task-running-dedup';
    insertQueueItem(ctx.db, {
      id: generateId(),
      status: 'running',
      lane: 'persistent',
      metadata: { persistentTaskId: taskId },
    });

    const result = ctx.db.prepare(
      "SELECT COUNT(*) as cnt FROM queue_items WHERE lane = 'persistent' AND status IN ('queued', 'running', 'spawning') AND json_extract(metadata, '$.persistentTaskId') = ?"
    ).get(taskId);

    assert.ok(result.cnt > 0, "'running' item must be found by dedup query");
  });

  it("does NOT find a 'completed' item — dedup is scoped to active statuses only", () => {
    const taskId = 'persistent-task-completed-dedup';
    insertQueueItem(ctx.db, {
      id: generateId(),
      status: 'completed',
      lane: 'persistent',
      metadata: { persistentTaskId: taskId },
    });

    const result = ctx.db.prepare(
      "SELECT COUNT(*) as cnt FROM queue_items WHERE lane = 'persistent' AND status IN ('queued', 'running', 'spawning') AND json_extract(metadata, '$.persistentTaskId') = ?"
    ).get(taskId);

    assert.strictEqual(result.cnt, 0, "'completed' items must not block revival (false positive)");
  });

  it("does NOT find a 'failed' item — dedup is scoped to active statuses only", () => {
    const taskId = 'persistent-task-failed-dedup';
    insertQueueItem(ctx.db, {
      id: generateId(),
      status: 'failed',
      lane: 'persistent',
      metadata: { persistentTaskId: taskId },
    });

    const result = ctx.db.prepare(
      "SELECT COUNT(*) as cnt FROM queue_items WHERE lane = 'persistent' AND status IN ('queued', 'running', 'spawning') AND json_extract(metadata, '$.persistentTaskId') = ?"
    ).get(taskId);

    assert.strictEqual(result.cnt, 0, "'failed' items must not block revival");
  });

  it("does NOT match items on a different lane even with matching persistentTaskId", () => {
    const taskId = 'persistent-task-wrong-lane';
    insertQueueItem(ctx.db, {
      id: generateId(),
      status: 'running',
      lane: 'standard', // wrong lane
      metadata: { persistentTaskId: taskId },
    });

    const result = ctx.db.prepare(
      "SELECT COUNT(*) as cnt FROM queue_items WHERE lane = 'persistent' AND status IN ('queued', 'running', 'spawning') AND json_extract(metadata, '$.persistentTaskId') = ?"
    ).get(taskId);

    assert.strictEqual(result.cnt, 0, "items on non-persistent lane must not match the dedup query");
  });
});

// ============================================================================
// Test Group 4: Circuit breaker threshold (3/10min via queue_items)
// ============================================================================

describe('Circuit breaker threshold alignment — 3 hard revivals per 10 minutes', () => {
  let ctx;
  const TASK_ID = 'circuit-breaker-task';

  beforeEach(() => { ctx = createTestDb('circuit-breaker-test'); });
  afterEach(() => { ctx.cleanup(); });

  it('2 hard revival queue items within 10 minutes does NOT trip the circuit breaker', () => {
    for (let i = 0; i < 2; i++) {
      insertQueueItem(ctx.db, {
        id: generateId(),
        status: 'completed',
        lane: 'persistent',
        metadata: { persistentTaskId: TASK_ID, revivalReason: 'immediate_reaper_revival' },
      });
    }

    const count = countCircuitBreakerHits(ctx.db, TASK_ID);
    assert.ok(count < 3, `circuit breaker must NOT trip at 2 revivals; count=${count}`);
  });

  it('3 hard revival queue items within 10 minutes TRIPS the circuit breaker (count >= 3)', () => {
    for (let i = 0; i < 3; i++) {
      insertQueueItem(ctx.db, {
        id: generateId(),
        status: 'completed',
        lane: 'persistent',
        metadata: { persistentTaskId: TASK_ID, revivalReason: 'immediate_reaper_revival' },
      });
    }

    const count = countCircuitBreakerHits(ctx.db, TASK_ID);
    assert.ok(count >= 3, `circuit breaker MUST trip at 3 revivals; count=${count}`);
  });

  it('heartbeat_stale_revival items are excluded from the circuit breaker count', () => {
    for (let i = 0; i < 3; i++) {
      insertQueueItem(ctx.db, {
        id: generateId(),
        status: 'completed',
        lane: 'persistent',
        metadata: { persistentTaskId: TASK_ID, revivalReason: 'heartbeat_stale_revival' },
      });
    }

    const count = countCircuitBreakerHits(ctx.db, TASK_ID);
    assert.strictEqual(count, 0, 'heartbeat_stale_revival items must not count toward circuit breaker');
  });

  it('items older than 10 minutes do NOT count toward circuit breaker', () => {
    for (let i = 0; i < 3; i++) {
      const id = generateId();
      ctx.db.prepare(`
        INSERT INTO queue_items
          (id, status, lane, spawn_type, title, agent_type, hook_type, tag_context, project_dir, source, metadata, enqueued_at)
        VALUES
          (?, 'completed', 'persistent', 'fresh', 'Test', 'persistent-monitor', 'persistent-monitor', 'test-ctx', '/tmp/test', 'test', ?, datetime('now', '-11 minutes'))
      `).run(id, JSON.stringify({ persistentTaskId: TASK_ID, revivalReason: 'immediate_reaper_revival' }));
    }

    const count = countCircuitBreakerHits(ctx.db, TASK_ID);
    assert.strictEqual(count, 0, 'items older than 10 minutes must not trip the circuit breaker');
  });

  it('auto-pause UPDATE sets status to paused when task is active', () => {
    // Create a minimal persistent-tasks.db to verify the auto-pause SQL works correctly
    const ptDbPath = path.join(os.tmpdir(), `pt-auto-pause-${Date.now()}.db`);
    const ptDb = new Database(ptDbPath);
    ptDb.exec(`
      CREATE TABLE IF NOT EXISTS persistent_tasks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'active',
        title TEXT NOT NULL
      );
    `);
    ptDb.prepare("INSERT INTO persistent_tasks (id, status, title) VALUES (?, 'active', 'Test task')")
      .run(TASK_ID);

    // Exact UPDATE from the circuit breaker auto-pause block in session-queue.js
    ptDb.prepare("UPDATE persistent_tasks SET status = 'paused' WHERE id = ? AND status = 'active'")
      .run(TASK_ID);

    const row = ptDb.prepare('SELECT status FROM persistent_tasks WHERE id = ?').get(TASK_ID);
    assert.strictEqual(row?.status, 'paused', 'circuit breaker auto-pause must set task status to paused');

    ptDb.close();
    for (const ext of ['', '-shm', '-wal']) {
      const f = ptDbPath + ext;
      if (fs.existsSync(f)) try { fs.unlinkSync(f); } catch (_) { /* non-fatal */ }
    }
  });

  it('auto-pause UPDATE is idempotent — already-paused task is not double-written', () => {
    const ptDbPath = path.join(os.tmpdir(), `pt-idempotent-${Date.now()}.db`);
    const ptDb = new Database(ptDbPath);
    ptDb.exec(`
      CREATE TABLE IF NOT EXISTS persistent_tasks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'active',
        title TEXT NOT NULL
      );
    `);
    ptDb.prepare("INSERT INTO persistent_tasks (id, status, title) VALUES (?, 'paused', 'Already paused')")
      .run(TASK_ID);

    // Second UPDATE must be a no-op (WHERE status = 'active' does not match 'paused')
    const info = ptDb.prepare(
      "UPDATE persistent_tasks SET status = 'paused' WHERE id = ? AND status = 'active'"
    ).run(TASK_ID);

    assert.strictEqual(info.changes, 0, 'UPDATE must affect 0 rows when task is already paused');

    ptDb.close();
    for (const ext of ['', '-shm', '-wal']) {
      const f = ptDbPath + ext;
      if (fs.existsSync(f)) try { fs.unlinkSync(f); } catch (_) { /* non-fatal */ }
    }
  });
});

// ============================================================================
// Test Group 5: Revival event persistence (survives DB close/reopen)
// ============================================================================

describe('Revival event persistence across DB close/reopen', () => {
  let dbPath;
  const TASK_ID = 'persistence-test-task';

  beforeEach(() => {
    dbPath = path.join(
      os.tmpdir(),
      `sq-persistence-${Date.now()}-${crypto.randomBytes(2).toString('hex')}.db`
    );
  });

  afterEach(() => {
    for (const ext of ['', '-shm', '-wal']) {
      const f = dbPath + ext;
      if (fs.existsSync(f)) try { fs.unlinkSync(f); } catch (_) { /* non-fatal */ }
    }
  });

  it('revival event inserted before close is readable after reopening the database', () => {
    // Session 1: open DB and insert a revival event
    const db1 = new Database(dbPath);
    db1.pragma('journal_mode = WAL');
    db1.exec(SCHEMA_SQL);
    db1.prepare('INSERT INTO revival_events (id, task_id, reason) VALUES (?, ?, ?)')
      .run('evt-persist-001', TASK_ID, 'hard_revival');
    db1.close();

    // Session 2: reopen DB — simulates process restart with empty in-memory map
    const db2 = new Database(dbPath);
    db2.pragma('journal_mode = WAL');

    const row = db2.prepare("SELECT * FROM revival_events WHERE id = 'evt-persist-001'").get();
    assert.ok(row, 'revival event must still exist after close/reopen');
    assert.strictEqual(row.task_id, TASK_ID, 'task_id must match after reload');
    assert.strictEqual(row.reason, 'hard_revival', 'reason must match after reload');
    db2.close();
  });

  it('rate limiter reads from DB when in-memory map is empty (cold-start path)', () => {
    // Session 1: simulate previous process run — insert 3 hard revival events
    const db1 = new Database(dbPath);
    db1.pragma('journal_mode = WAL');
    db1.exec(SCHEMA_SQL);
    insertRevivalEvent(db1, { taskId: TASK_ID, reason: 'hard_revival', offsetMinutes: -1 });
    insertRevivalEvent(db1, { taskId: TASK_ID, reason: 'hard_revival', offsetMinutes: -2 });
    insertRevivalEvent(db1, { taskId: TASK_ID, reason: 'hard_revival', offsetMinutes: -3 });
    db1.close();

    // Session 2: fresh process — in-memory map is empty, rate limiter falls back to DB
    const db2 = new Database(dbPath);
    db2.pragma('journal_mode = WAL');

    // Exact cold-start DB query from requeueDeadPersistentMonitor()
    const result = db2.prepare(
      "SELECT COUNT(*) as cnt FROM revival_events WHERE task_id = ? AND created_at > datetime('now', '-10 minutes') AND reason != 'stale_heartbeat'"
    ).get(TASK_ID);

    assert.ok(
      result.cnt >= 3,
      `cold-start DB rate limiter must see 3 persisted hard revivals; got cnt=${result.cnt}`
    );
    db2.close();
  });

  it('stale_heartbeat events from previous session do not trip rate limit on cold-start', () => {
    const db1 = new Database(dbPath);
    db1.pragma('journal_mode = WAL');
    db1.exec(SCHEMA_SQL);
    insertRevivalEvent(db1, { taskId: TASK_ID, reason: 'stale_heartbeat', offsetMinutes: -1 });
    insertRevivalEvent(db1, { taskId: TASK_ID, reason: 'stale_heartbeat', offsetMinutes: -2 });
    insertRevivalEvent(db1, { taskId: TASK_ID, reason: 'stale_heartbeat', offsetMinutes: -3 });
    db1.close();

    const db2 = new Database(dbPath);
    db2.pragma('journal_mode = WAL');

    const result = db2.prepare(
      "SELECT COUNT(*) as cnt FROM revival_events WHERE task_id = ? AND created_at > datetime('now', '-10 minutes') AND reason != 'stale_heartbeat'"
    ).get(TASK_ID);

    assert.strictEqual(
      result.cnt, 0,
      'stale_heartbeat events from previous session must not trip the cold-start rate limit'
    );
    db2.close();
  });

  it('events accumulate correctly across multiple DB opens', () => {
    // Session 1: insert 1 event
    const db1 = new Database(dbPath);
    db1.pragma('journal_mode = WAL');
    db1.exec(SCHEMA_SQL);
    insertRevivalEvent(db1, { taskId: TASK_ID, reason: 'hard_revival', offsetMinutes: -1 });
    db1.close();

    // Session 2: insert 2 more events and verify all 3 are present
    const db2 = new Database(dbPath);
    db2.pragma('journal_mode = WAL');
    insertRevivalEvent(db2, { taskId: TASK_ID, reason: 'hard_revival', offsetMinutes: 0 });
    insertRevivalEvent(db2, { taskId: TASK_ID, reason: 'hard_revival', offsetMinutes: 0 });

    const total = db2.prepare('SELECT COUNT(*) as cnt FROM revival_events WHERE task_id = ?')
      .get(TASK_ID);
    assert.strictEqual(total.cnt, 3, 'all 3 events across 2 sessions must be present');

    const recentHard = db2.prepare(
      "SELECT COUNT(*) as cnt FROM revival_events WHERE task_id = ? AND created_at > datetime('now', '-10 minutes') AND reason != 'stale_heartbeat'"
    ).get(TASK_ID);
    assert.ok(recentHard.cnt >= 2, `at least 2 recent events must be present; got ${recentHard.cnt}`);
    db2.close();
  });
});

// ============================================================================
// Test Group 6: Source-code structural verification
// ============================================================================

describe('session-queue.js source — structural circuit breaker verification', () => {
  let sourceCode;

  before(() => {
    const sourcePath = new URL('../lib/session-queue.js', import.meta.url).pathname;
    sourceCode = fs.readFileSync(sourcePath, 'utf8');
  });

  it('revival_events table is created with CREATE TABLE IF NOT EXISTS', () => {
    assert.ok(
      sourceCode.includes('CREATE TABLE IF NOT EXISTS revival_events'),
      'revival_events table must be created idempotently with CREATE TABLE IF NOT EXISTS'
    );
  });

  it('idx_revival_task_time index is created on (task_id, created_at)', () => {
    assert.ok(
      sourceCode.includes('CREATE INDEX IF NOT EXISTS idx_revival_task_time ON revival_events(task_id, created_at)'),
      'idx_revival_task_time must be created on revival_events(task_id, created_at)'
    );
  });

  it("DB rate limiter query excludes stale_heartbeat via reason != 'stale_heartbeat'", () => {
    assert.ok(
      sourceCode.includes("AND reason != 'stale_heartbeat'"),
      "DB rate limiter query must exclude stale_heartbeat events"
    );
  });

  it("revival_events INSERT classifies stale_heartbeat vs hard_revival correctly", () => {
    assert.ok(
      sourceCode.includes("reapReason === 'stale_heartbeat' ? 'stale_heartbeat' : 'hard_revival'"),
      "revival_events INSERT must map stale_heartbeat to 'stale_heartbeat' and all others to 'hard_revival'"
    );
  });

  it('in-memory rate limiter threshold is exactly >= 3', () => {
    assert.ok(
      sourceCode.includes('recentHardCount >= 3'),
      'in-memory rate limiter must use threshold >= 3'
    );
  });

  it('circuit breaker (queue_items) threshold is exactly >= 3', () => {
    assert.ok(
      sourceCode.includes('dbRecentRevivals.cnt >= 3'),
      'circuit breaker (queue_items path) must use threshold >= 3'
    );
  });

  it("dedup for persistent monitors checks status IN ('queued', 'running', 'spawning')", () => {
    // The fix for the Step 1b / Step 1c race condition
    assert.ok(
      sourceCode.includes("status IN ('queued', 'running', 'spawning')") &&
      sourceCode.includes("lane = 'persistent'"),
      "persistent monitor dedup must check status IN ('queued', 'running', 'spawning') with lane = 'persistent' constraint"
    );
  });

  it('revival event is persisted to DB after successful enqueue', () => {
    assert.ok(
      sourceCode.includes("INSERT INTO revival_events (id, task_id, reason, created_at) VALUES"),
      'revival event must be persisted to revival_events table after successful enqueue'
    );
  });
});
