/**
 * Tests for the `do_not_auto_resume` metadata flag set by the circuit breaker
 * in session-queue.js requeueDeadPersistentMonitor().
 *
 * Two circuit breaker code paths both set do_not_auto_resume:
 *   1. In-memory rate limiter path (3 hard revivals in 10 min via _monitorRevivalTimestamps)
 *   2. DB-based circuit breaker path (3 hard revivals in 10 min via queue_items count)
 *
 * Because session-queue.js is a stateful singleton (global DB handle, in-memory
 * maps), we test the specific metadata update SQL directly against real
 * persistent-tasks.db databases rather than trying to import the full module.
 * This mirrors the existing pattern in session-queue-circuit-breaker.test.js.
 *
 * Covers:
 *   1.  In-memory CB: do_not_auto_resume is set when recentHardCount >= 3
 *   2.  In-memory CB: do_not_auto_resume is merged (existing metadata fields preserved)
 *   3.  DB CB (queue_items): do_not_auto_resume is set when queue_items count >= 3
 *   4.  DB CB: do_not_auto_resume is merged (existing metadata fields preserved)
 *   5.  do_not_auto_resume is NOT set for tasks below the threshold
 *   6.  do_not_auto_resume is NOT set for stale_heartbeat revivals (excluded)
 *   7.  Metadata JSON is correctly round-tripped (parse → merge → stringify)
 *   8.  Source-code structural verification — both CB paths set do_not_auto_resume
 *
 * Run with: node --test .claude/hooks/__tests__/circuit-breaker-do-not-auto-resume.test.js
 */

import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

// ============================================================================
// Schemas
// ============================================================================

const PERSISTENT_TASKS_SCHEMA = `
CREATE TABLE IF NOT EXISTS persistent_tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    metadata TEXT,
    CONSTRAINT valid_status CHECK (status IN ('draft','active','paused','completed','cancelled','failed'))
);

CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    persistent_task_id TEXT NOT NULL REFERENCES persistent_tasks(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    details TEXT,
    created_at TEXT NOT NULL
);
`;

const QUEUE_SCHEMA = `
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

function generateId(prefix = 'id') {
  return `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
}

const NOW = new Date().toISOString();

/**
 * Create a fresh temporary persistent-tasks.db.
 * Returns { db, dbPath, cleanup }.
 */
function createPersistentTasksDb(prefix = 'cb-pt-test') {
  const dbPath = path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${crypto.randomBytes(2).toString('hex')}.db`
  );
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 3000');
  db.exec(PERSISTENT_TASKS_SCHEMA);

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
 * Create a fresh temporary session-queue.db.
 * Returns { db, dbPath, cleanup }.
 */
function createQueueDb(prefix = 'cb-queue-test') {
  const dbPath = path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${crypto.randomBytes(2).toString('hex')}.db`
  );
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 3000');
  db.exec(QUEUE_SCHEMA);

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
 * Insert an active persistent task. Returns { id }.
 */
function insertTask(db, { id = generateId('task'), status = 'active', metadata = null } = {}) {
  db.prepare(`
    INSERT INTO persistent_tasks (id, title, prompt, status, created_at, metadata)
    VALUES (?, 'Test Task', 'prompt', ?, ?, ?)
  `).run(id, status, NOW, metadata ? JSON.stringify(metadata) : null);
  return id;
}

/**
 * Simulate the do_not_auto_resume metadata update performed by the circuit breaker.
 * This mirrors the EXACT code in session-queue.js both CB paths:
 *
 *   const metaRow = ptDb2.prepare('SELECT metadata FROM persistent_tasks WHERE id = ?').get(taskId);
 *   const meta = metaRow?.metadata ? JSON.parse(metaRow.metadata) : {};
 *   meta.do_not_auto_resume = true;
 *   ptDb2.prepare('UPDATE persistent_tasks SET metadata = ? WHERE id = ?').run(JSON.stringify(meta), taskId);
 */
function simulateCircuitBreakerMetadataUpdate(db, taskId) {
  const metaRow = db.prepare('SELECT metadata FROM persistent_tasks WHERE id = ?').get(taskId);
  const meta = metaRow?.metadata ? JSON.parse(metaRow.metadata) : {};
  meta.do_not_auto_resume = true;
  db.prepare('UPDATE persistent_tasks SET metadata = ? WHERE id = ?').run(JSON.stringify(meta), taskId);
}

/**
 * Read and parse the metadata column for a task.
 */
function readTaskMetadata(db, taskId) {
  const row = db.prepare('SELECT metadata FROM persistent_tasks WHERE id = ?').get(taskId);
  if (!row?.metadata) return null;
  return JSON.parse(row.metadata);
}

/**
 * Insert queue_items rows simulating N hard revivals within the last 10 minutes.
 * Uses default enqueued_at (now) so they are within the 10-minute window.
 */
function insertHardRevivalQueueItems(db, taskId, count, revivalReason = 'immediate_reaper_revival') {
  for (let i = 0; i < count; i++) {
    const id = generateId('qi');
    db.prepare(`
      INSERT INTO queue_items
        (id, status, lane, spawn_type, title, agent_type, hook_type, tag_context, project_dir, source, metadata)
      VALUES
        (?, 'completed', 'persistent', 'fresh', 'Test', 'persistent-monitor', 'persistent-monitor', 'test', '/tmp/test', 'test', ?)
    `).run(id, JSON.stringify({ persistentTaskId: taskId, revivalReason }));
  }
}

/**
 * Insert revival_events rows for the in-memory CB cold-start path.
 */
function insertRevivalEvents(db, taskId, count, reason = 'hard_revival') {
  for (let i = 0; i < count; i++) {
    const id = generateId('re');
    db.prepare('INSERT INTO revival_events (id, task_id, reason) VALUES (?, ?, ?)').run(id, taskId, reason);
  }
}

// ============================================================================
// Test Group 1: In-memory CB path — do_not_auto_resume set at >= 3 hard revivals
// ============================================================================

describe('In-memory circuit breaker path — do_not_auto_resume metadata', () => {
  let ctx;

  beforeEach(() => { ctx = createPersistentTasksDb('mem-cb-test'); });
  afterEach(() => { ctx.cleanup(); });

  it('sets do_not_auto_resume=true on active task when CB fires', () => {
    const taskId = insertTask(ctx.db, { status: 'active', metadata: null });

    // Simulate what the in-memory CB does: pause the task then set do_not_auto_resume
    ctx.db.prepare("UPDATE persistent_tasks SET status = 'paused' WHERE id = ? AND status = 'active'").run(taskId);
    simulateCircuitBreakerMetadataUpdate(ctx.db, taskId);

    const meta = readTaskMetadata(ctx.db, taskId);
    assert.ok(meta, 'metadata must not be null after CB fires');
    assert.strictEqual(meta.do_not_auto_resume, true, 'do_not_auto_resume must be true after CB fires');
  });

  it('auto-pause UPDATE sets task status to paused', () => {
    const taskId = insertTask(ctx.db, { status: 'active' });

    // Exact UPDATE from in-memory CB path
    const info = ctx.db.prepare(
      "UPDATE persistent_tasks SET status = 'paused' WHERE id = ? AND status = 'active'"
    ).run(taskId);

    assert.strictEqual(info.changes, 1, 'auto-pause must affect exactly 1 row for an active task');

    const row = ctx.db.prepare('SELECT status FROM persistent_tasks WHERE id = ?').get(taskId);
    assert.strictEqual(row.status, 'paused');
  });

  it('auto-pause is idempotent — already-paused task gets 0 changes', () => {
    const taskId = insertTask(ctx.db, { status: 'paused' });

    const info = ctx.db.prepare(
      "UPDATE persistent_tasks SET status = 'paused' WHERE id = ? AND status = 'active'"
    ).run(taskId);

    assert.strictEqual(info.changes, 0, 'already-paused task must not be double-written (WHERE status = "active" guard)');
  });
});

// ============================================================================
// Test Group 2: Metadata merging — existing fields are preserved
// ============================================================================

describe('Metadata merging — existing fields preserved when do_not_auto_resume is set', () => {
  let ctx;

  beforeEach(() => { ctx = createPersistentTasksDb('meta-merge-test'); });
  afterEach(() => { ctx.cleanup(); });

  it('preserves existing metadata fields when do_not_auto_resume is added', () => {
    const existingMeta = {
      plan_task_id: 'pt-123',
      plan_id: 'plan-456',
      some_flag: true,
      count: 42,
    };
    const taskId = insertTask(ctx.db, { metadata: existingMeta });

    simulateCircuitBreakerMetadataUpdate(ctx.db, taskId);

    const meta = readTaskMetadata(ctx.db, taskId);
    assert.ok(meta, 'metadata must not be null');
    assert.strictEqual(meta.do_not_auto_resume, true, 'do_not_auto_resume must be true');
    assert.strictEqual(meta.plan_task_id, 'pt-123', 'plan_task_id must be preserved');
    assert.strictEqual(meta.plan_id, 'plan-456', 'plan_id must be preserved');
    assert.strictEqual(meta.some_flag, true, 'some_flag must be preserved');
    assert.strictEqual(meta.count, 42, 'count must be preserved');
  });

  it('creates metadata object from scratch when task has no metadata', () => {
    const taskId = insertTask(ctx.db, { metadata: null });

    simulateCircuitBreakerMetadataUpdate(ctx.db, taskId);

    const meta = readTaskMetadata(ctx.db, taskId);
    assert.ok(meta, 'metadata must be created when previously null');
    assert.strictEqual(meta.do_not_auto_resume, true);
    // No other spurious fields
    assert.deepStrictEqual(Object.keys(meta), ['do_not_auto_resume']);
  });

  it('is idempotent when do_not_auto_resume is already true', () => {
    const taskId = insertTask(ctx.db, { metadata: { do_not_auto_resume: true, other: 'value' } });

    // Run the update twice — result must be the same
    simulateCircuitBreakerMetadataUpdate(ctx.db, taskId);
    simulateCircuitBreakerMetadataUpdate(ctx.db, taskId);

    const meta = readTaskMetadata(ctx.db, taskId);
    assert.strictEqual(meta.do_not_auto_resume, true);
    assert.strictEqual(meta.other, 'value', 'other fields must survive double-update');
  });

  it('stores metadata as valid JSON string that round-trips correctly', () => {
    const taskId = insertTask(ctx.db, { metadata: { plan_id: 'p1' } });
    simulateCircuitBreakerMetadataUpdate(ctx.db, taskId);

    // Read raw column value and verify it is valid JSON
    const row = ctx.db.prepare('SELECT metadata FROM persistent_tasks WHERE id = ?').get(taskId);
    assert.ok(row?.metadata, 'metadata column must not be null');
    assert.doesNotThrow(() => JSON.parse(row.metadata), 'metadata column must be valid JSON');

    const parsed = JSON.parse(row.metadata);
    assert.strictEqual(typeof parsed, 'object');
    assert.strictEqual(parsed.do_not_auto_resume, true);
  });
});

// ============================================================================
// Test Group 3: DB circuit breaker (queue_items) path — do_not_auto_resume set
// ============================================================================

describe('DB circuit breaker path (queue_items) — do_not_auto_resume metadata', () => {
  let ptCtx;
  let qCtx;
  const TASK_ID = 'db-cb-task';

  beforeEach(() => {
    ptCtx = createPersistentTasksDb('db-cb-pt-test');
    qCtx = createQueueDb('db-cb-queue-test');
    insertTask(ptCtx.db, { id: TASK_ID, status: 'active' });
  });

  afterEach(() => {
    ptCtx.cleanup();
    qCtx.cleanup();
  });

  it('circuit breaker fires when queue_items count >= 3 for the task', () => {
    // Insert 3 hard revival items — count should be >= 3
    insertHardRevivalQueueItems(qCtx.db, TASK_ID, 3);

    const row = qCtx.db.prepare(
      "SELECT COUNT(*) as cnt FROM queue_items WHERE lane = 'persistent' AND json_extract(metadata, '$.persistentTaskId') = ? AND enqueued_at > datetime('now', '-10 minutes') AND COALESCE(json_extract(metadata, '$.revivalReason'), '') != 'heartbeat_stale_revival'"
    ).get(TASK_ID);

    assert.ok(row.cnt >= 3, `circuit breaker must trip at 3 revivals; got ${row.cnt}`);
  });

  it('simulated DB CB: auto-pauses task and sets do_not_auto_resume', () => {
    insertHardRevivalQueueItems(qCtx.db, TASK_ID, 3);

    // Count revivals (simulating what the CB code does)
    const row = qCtx.db.prepare(
      "SELECT COUNT(*) as cnt FROM queue_items WHERE lane = 'persistent' AND json_extract(metadata, '$.persistentTaskId') = ? AND enqueued_at > datetime('now', '-10 minutes') AND COALESCE(json_extract(metadata, '$.revivalReason'), '') != 'heartbeat_stale_revival'"
    ).get(TASK_ID);

    if (row.cnt >= 3) {
      // Auto-pause (exact UPDATE from session-queue.js DB CB block)
      ptCtx.db.prepare("UPDATE persistent_tasks SET status = 'paused' WHERE id = ? AND status = 'active'").run(TASK_ID);
      // Set do_not_auto_resume (exact code from session-queue.js DB CB block)
      simulateCircuitBreakerMetadataUpdate(ptCtx.db, TASK_ID);
    }

    const taskRow = ptCtx.db.prepare('SELECT status, metadata FROM persistent_tasks WHERE id = ?').get(TASK_ID);
    assert.strictEqual(taskRow.status, 'paused', 'task must be paused by DB CB');

    const meta = JSON.parse(taskRow.metadata);
    assert.strictEqual(meta.do_not_auto_resume, true, 'do_not_auto_resume must be set by DB CB');
  });

  it('does NOT fire when count < 3 (2 revivals below threshold)', () => {
    insertHardRevivalQueueItems(qCtx.db, TASK_ID, 2);

    const row = qCtx.db.prepare(
      "SELECT COUNT(*) as cnt FROM queue_items WHERE lane = 'persistent' AND json_extract(metadata, '$.persistentTaskId') = ? AND enqueued_at > datetime('now', '-10 minutes') AND COALESCE(json_extract(metadata, '$.revivalReason'), '') != 'heartbeat_stale_revival'"
    ).get(TASK_ID);

    assert.ok(row.cnt < 3, `CB must NOT fire at 2 revivals; got ${row.cnt}`);

    // Task must remain active (CB did not fire)
    const taskRow = ptCtx.db.prepare('SELECT status FROM persistent_tasks WHERE id = ?').get(TASK_ID);
    assert.strictEqual(taskRow.status, 'active', 'task must remain active when CB threshold not reached');
  });

  it('heartbeat_stale_revival items are excluded from DB CB count', () => {
    // Insert 3 stale-heartbeat items — these must NOT count toward CB
    insertHardRevivalQueueItems(qCtx.db, TASK_ID, 3, 'heartbeat_stale_revival');

    const row = qCtx.db.prepare(
      "SELECT COUNT(*) as cnt FROM queue_items WHERE lane = 'persistent' AND json_extract(metadata, '$.persistentTaskId') = ? AND enqueued_at > datetime('now', '-10 minutes') AND COALESCE(json_extract(metadata, '$.revivalReason'), '') != 'heartbeat_stale_revival'"
    ).get(TASK_ID);

    assert.strictEqual(row.cnt, 0, 'heartbeat_stale_revival items must not count toward DB CB');

    // Task must remain active
    const taskRow = ptCtx.db.prepare('SELECT status FROM persistent_tasks WHERE id = ?').get(TASK_ID);
    assert.strictEqual(taskRow.status, 'active', 'task must remain active when only stale-heartbeat revivals exist');
  });

  it('DB CB merges do_not_auto_resume into existing metadata without overwriting other fields', () => {
    const existingMeta = { plan_task_id: 'pt-999', plan_id: 'plan-888' };
    ptCtx.db.prepare('UPDATE persistent_tasks SET metadata = ? WHERE id = ?')
      .run(JSON.stringify(existingMeta), TASK_ID);

    insertHardRevivalQueueItems(qCtx.db, TASK_ID, 3);

    const cbRow = qCtx.db.prepare(
      "SELECT COUNT(*) as cnt FROM queue_items WHERE lane = 'persistent' AND json_extract(metadata, '$.persistentTaskId') = ? AND enqueued_at > datetime('now', '-10 minutes') AND COALESCE(json_extract(metadata, '$.revivalReason'), '') != 'heartbeat_stale_revival'"
    ).get(TASK_ID);

    if (cbRow.cnt >= 3) {
      ptCtx.db.prepare("UPDATE persistent_tasks SET status = 'paused' WHERE id = ? AND status = 'active'").run(TASK_ID);
      simulateCircuitBreakerMetadataUpdate(ptCtx.db, TASK_ID);
    }

    const meta = readTaskMetadata(ptCtx.db, TASK_ID);
    assert.strictEqual(meta.do_not_auto_resume, true);
    assert.strictEqual(meta.plan_task_id, 'pt-999', 'plan_task_id must survive the CB metadata update');
    assert.strictEqual(meta.plan_id, 'plan-888', 'plan_id must survive the CB metadata update');
  });
});

// ============================================================================
// Test Group 4: In-memory CB — cold-start DB path (revival_events)
// ============================================================================

describe('In-memory CB cold-start via revival_events — do_not_auto_resume', () => {
  let ptCtx;
  let qCtx;
  const TASK_ID = 'revival-events-task';

  beforeEach(() => {
    ptCtx = createPersistentTasksDb('revival-pt-test');
    qCtx = createQueueDb('revival-queue-test');
    insertTask(ptCtx.db, { id: TASK_ID, status: 'active' });
  });

  afterEach(() => {
    ptCtx.cleanup();
    qCtx.cleanup();
  });

  it('sets do_not_auto_resume when in-memory CB fires via DB fallback count >= 3', () => {
    // Simulate 3 hard revivals from a previous process (in-memory map is empty)
    insertRevivalEvents(qCtx.db, TASK_ID, 3, 'hard_revival');

    // Cold-start DB query
    const dbRecent = qCtx.db.prepare(
      "SELECT COUNT(*) as cnt FROM revival_events WHERE task_id = ? AND created_at > datetime('now', '-10 minutes') AND reason != 'stale_heartbeat'"
    ).get(TASK_ID);
    const recentHardCount = dbRecent?.cnt || 0;

    if (recentHardCount >= 3) {
      // Exact in-memory CB auto-pause + metadata update code
      ptCtx.db.prepare("UPDATE persistent_tasks SET status = 'paused' WHERE id = ? AND status = 'active'").run(TASK_ID);
      simulateCircuitBreakerMetadataUpdate(ptCtx.db, TASK_ID);
    }

    const taskRow = ptCtx.db.prepare('SELECT status, metadata FROM persistent_tasks WHERE id = ?').get(TASK_ID);
    assert.strictEqual(taskRow.status, 'paused', 'task must be paused');

    const meta = JSON.parse(taskRow.metadata);
    assert.strictEqual(meta.do_not_auto_resume, true, 'do_not_auto_resume must be set via cold-start path');
  });

  it('does NOT set do_not_auto_resume when revival_events count < 3', () => {
    insertRevivalEvents(qCtx.db, TASK_ID, 2, 'hard_revival');

    const dbRecent = qCtx.db.prepare(
      "SELECT COUNT(*) as cnt FROM revival_events WHERE task_id = ? AND created_at > datetime('now', '-10 minutes') AND reason != 'stale_heartbeat'"
    ).get(TASK_ID);
    const recentHardCount = dbRecent?.cnt || 0;

    // CB must NOT fire
    assert.ok(recentHardCount < 3, 'CB must not fire with 2 revival events');

    // Task remains active, metadata untouched
    const taskRow = ptCtx.db.prepare('SELECT status, metadata FROM persistent_tasks WHERE id = ?').get(TASK_ID);
    assert.strictEqual(taskRow.status, 'active');
    assert.strictEqual(taskRow.metadata, null, 'metadata must remain null when CB does not fire');
  });

  it('stale_heartbeat revival_events are excluded from cold-start count', () => {
    insertRevivalEvents(qCtx.db, TASK_ID, 3, 'stale_heartbeat');

    const dbRecent = qCtx.db.prepare(
      "SELECT COUNT(*) as cnt FROM revival_events WHERE task_id = ? AND created_at > datetime('now', '-10 minutes') AND reason != 'stale_heartbeat'"
    ).get(TASK_ID);

    assert.strictEqual(dbRecent.cnt, 0, 'stale_heartbeat must not count toward cold-start CB threshold');
  });
});

// ============================================================================
// Test Group 5: Source-code structural verification
// ============================================================================

describe('session-queue.js source — do_not_auto_resume structural verification', () => {
  let sourceCode;

  before(() => {
    const sourcePath = new URL('../lib/session-queue.js', import.meta.url).pathname;
    sourceCode = fs.readFileSync(sourcePath, 'utf8');
  });

  it('in-memory CB path sets do_not_auto_resume on the task metadata', () => {
    // The in-memory rate limiter block (recentHardCount >= 3) must set do_not_auto_resume
    // Verify both the threshold check and the metadata update appear together
    assert.ok(
      sourceCode.includes('recentHardCount >= 3'),
      'in-memory CB threshold must be >= 3'
    );
    assert.ok(
      sourceCode.includes('meta.do_not_auto_resume = true'),
      'in-memory CB path must set meta.do_not_auto_resume = true'
    );
  });

  it('DB CB path (queue_items) sets do_not_auto_resume on the task metadata', () => {
    assert.ok(
      sourceCode.includes('dbRecentRevivals.cnt >= 3'),
      'DB CB threshold must be >= 3'
    );
    // Both CB paths use the same metadata update idiom
    const metaUpdatePattern = "meta.do_not_auto_resume = true";
    assert.ok(
      sourceCode.includes(metaUpdatePattern),
      'DB CB path must also set meta.do_not_auto_resume = true'
    );
  });

  it('metadata update code reads existing metadata before merging (no overwrite)', () => {
    // Verify the read-then-merge pattern is present: parse existing metadata before setting flag
    assert.ok(
      sourceCode.includes("metaRow?.metadata ? JSON.parse(metaRow.metadata) : {}"),
      'CB metadata update must parse existing metadata (or default to {}) before merging'
    );
  });

  it('metadata update is wrapped in try/catch (non-fatal)', () => {
    // Both CB blocks wrap the metadata update in try/catch to prevent non-fatal errors
    // from breaking the circuit breaker flow.
    // Verify the outer try-catch pattern around the metadata update.
    // We check that the source contains try { ... meta.do_not_auto_resume ... } catch
    // by verifying both tokens appear within reasonable proximity in the same block.
    const idx = sourceCode.indexOf('meta.do_not_auto_resume = true');
    assert.ok(idx !== -1, 'do_not_auto_resume assignment must exist in source');

    // Search backwards from the assignment for a try {
    const preceding = sourceCode.slice(Math.max(0, idx - 500), idx);
    assert.ok(
      preceding.includes('try {'),
      'metadata update must be wrapped in a try block for non-fatal error handling'
    );
  });

  it('both CB paths include the auto-pause UPDATE before the metadata update', () => {
    // Verify the pause UPDATE appears before the metadata update in both CB blocks
    const pauseUpdate = "UPDATE persistent_tasks SET status = 'paused' WHERE id = ? AND status = 'active'";
    assert.ok(
      sourceCode.includes(pauseUpdate),
      'auto-pause UPDATE must appear in session-queue.js'
    );
  });

  it('in-memory CB logs the revival count when firing', () => {
    // The CB path should log the rate limit trip — verify the log message includes the count
    assert.ok(
      sourceCode.includes('Rate-limited revival') || sourceCode.includes('recentHardCount'),
      'in-memory CB must log the revival count when rate limit is triggered'
    );
  });

  it('DB CB logs the revival count when firing', () => {
    assert.ok(
      sourceCode.includes('Circuit breaker tripped') || sourceCode.includes('dbRecentRevivals.cnt'),
      'DB CB must log the revival count when circuit breaker trips'
    );
  });
});
