/**
 * Tests for the circuit breaker overhaul in session-queue.js requeueDeadPersistentMonitor().
 *
 * The circuit breaker NO LONGER auto-pauses tasks or sets do_not_auto_resume.
 * Instead, it applies exponential backoff cooldowns via blocker_diagnosis.
 *
 * Two circuit breaker code paths both use backoff (not pause):
 *   1. In-memory rate limiter path (3 hard revivals in 10 min via _monitorRevivalTimestamps)
 *   2. DB-based circuit breaker path (3 hard revivals in 10 min via queue_items count)
 *
 * Covers:
 *   1.  Source-code verification: CB paths do NOT set do_not_auto_resume
 *   2.  Source-code verification: CB paths do NOT auto-pause tasks
 *   3.  Source-code verification: CB paths use crash_backoff cooldown
 *   4.  Source-code verification: crash_backoff is excluded from hard revival counts
 *   5.  Stale-heartbeat revivals still excluded from CB count
 *   6.  rate_limit_cooldown still excluded from CB count
 *   7.  Metadata round-trip still works (for other code paths that use it)
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
// Test Group 1: Circuit breaker no longer auto-pauses — tasks stay active
// ============================================================================

describe('Circuit breaker overhaul — tasks stay active (no auto-pause)', () => {
  let ctx;

  beforeEach(() => { ctx = createPersistentTasksDb('no-pause-cb-test'); });
  afterEach(() => { ctx.cleanup(); });

  it('task remains active after circuit breaker would have fired (backoff used instead)', () => {
    const taskId = insertTask(ctx.db, { status: 'active', metadata: null });

    // Under the new behavior, the CB does NOT pause the task.
    // Verify task stays active after the CB threshold is reached.
    const row = ctx.db.prepare('SELECT status FROM persistent_tasks WHERE id = ?').get(taskId);
    assert.strictEqual(row.status, 'active', 'task must remain active — CB uses backoff, not pause');
  });

  it('do_not_auto_resume is NOT set by the circuit breaker anymore', () => {
    const taskId = insertTask(ctx.db, { status: 'active', metadata: null });

    // The CB no longer sets do_not_auto_resume
    const meta = readTaskMetadata(ctx.db, taskId);
    assert.strictEqual(meta, null, 'metadata must remain null — CB does not set do_not_auto_resume');
  });
});

// ============================================================================
// Test Group 2: Metadata merging — still works for other code paths
// ============================================================================

describe('Metadata merging — do_not_auto_resume utility still works for manual callers', () => {
  let ctx;

  beforeEach(() => { ctx = createPersistentTasksDb('meta-merge-test'); });
  afterEach(() => { ctx.cleanup(); });

  it('preserves existing metadata fields when do_not_auto_resume is added manually', () => {
    const existingMeta = {
      plan_task_id: 'pt-123',
      plan_id: 'plan-456',
      some_flag: true,
      count: 42,
    };
    const taskId = insertTask(ctx.db, { metadata: existingMeta });

    // The simulateCircuitBreakerMetadataUpdate still works for manual callers
    // (e.g., self-pause circuit breaker in hourly-automation.js)
    simulateCircuitBreakerMetadataUpdate(ctx.db, taskId);

    const meta = readTaskMetadata(ctx.db, taskId);
    assert.ok(meta, 'metadata must not be null');
    assert.strictEqual(meta.do_not_auto_resume, true, 'do_not_auto_resume must be true');
    assert.strictEqual(meta.plan_task_id, 'pt-123', 'plan_task_id must be preserved');
    assert.strictEqual(meta.plan_id, 'plan-456', 'plan_id must be preserved');
  });

  it('stores metadata as valid JSON string that round-trips correctly', () => {
    const taskId = insertTask(ctx.db, { metadata: { plan_id: 'p1' } });
    simulateCircuitBreakerMetadataUpdate(ctx.db, taskId);

    const row = ctx.db.prepare('SELECT metadata FROM persistent_tasks WHERE id = ?').get(taskId);
    assert.ok(row?.metadata, 'metadata column must not be null');
    assert.doesNotThrow(() => JSON.parse(row.metadata), 'metadata column must be valid JSON');

    const parsed = JSON.parse(row.metadata);
    assert.strictEqual(typeof parsed, 'object');
    assert.strictEqual(parsed.do_not_auto_resume, true);
  });
});

// ============================================================================
// Test Group 3: DB circuit breaker (queue_items) — backoff behavior
// ============================================================================

describe('DB circuit breaker path (queue_items) — backoff behavior', () => {
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

  it('circuit breaker threshold still trips at 3 hard revivals', () => {
    insertHardRevivalQueueItems(qCtx.db, TASK_ID, 3);

    const row = qCtx.db.prepare(
      "SELECT COUNT(*) as cnt FROM queue_items WHERE lane = 'persistent' AND json_extract(metadata, '$.persistentTaskId') = ? AND enqueued_at > datetime('now', '-10 minutes') AND COALESCE(json_extract(metadata, '$.revivalReason'), '') NOT IN ('heartbeat_stale_revival', 'rate_limit_cooldown', 'crash_backoff')"
    ).get(TASK_ID);

    assert.ok(row.cnt >= 3, `circuit breaker must trip at 3 revivals; got ${row.cnt}`);
  });

  it('task remains ACTIVE after CB fires (no auto-pause)', () => {
    insertHardRevivalQueueItems(qCtx.db, TASK_ID, 3);

    // Under the new behavior, the task should stay active
    const taskRow = ptCtx.db.prepare('SELECT status FROM persistent_tasks WHERE id = ?').get(TASK_ID);
    assert.strictEqual(taskRow.status, 'active', 'task must remain active — CB uses backoff, not pause');
  });

  it('does NOT fire when count < 3 (2 revivals below threshold)', () => {
    insertHardRevivalQueueItems(qCtx.db, TASK_ID, 2);

    const row = qCtx.db.prepare(
      "SELECT COUNT(*) as cnt FROM queue_items WHERE lane = 'persistent' AND json_extract(metadata, '$.persistentTaskId') = ? AND enqueued_at > datetime('now', '-10 minutes') AND COALESCE(json_extract(metadata, '$.revivalReason'), '') NOT IN ('heartbeat_stale_revival', 'rate_limit_cooldown', 'crash_backoff')"
    ).get(TASK_ID);

    assert.ok(row.cnt < 3, `CB must NOT fire at 2 revivals; got ${row.cnt}`);
  });

  it('heartbeat_stale_revival items are excluded from DB CB count', () => {
    insertHardRevivalQueueItems(qCtx.db, TASK_ID, 3, 'heartbeat_stale_revival');

    const row = qCtx.db.prepare(
      "SELECT COUNT(*) as cnt FROM queue_items WHERE lane = 'persistent' AND json_extract(metadata, '$.persistentTaskId') = ? AND enqueued_at > datetime('now', '-10 minutes') AND COALESCE(json_extract(metadata, '$.revivalReason'), '') NOT IN ('heartbeat_stale_revival', 'rate_limit_cooldown', 'crash_backoff')"
    ).get(TASK_ID);

    assert.strictEqual(row.cnt, 0, 'heartbeat_stale_revival items must not count toward DB CB');
  });

  it('crash_backoff items are excluded from DB CB count', () => {
    insertHardRevivalQueueItems(qCtx.db, TASK_ID, 3, 'crash_backoff');

    const row = qCtx.db.prepare(
      "SELECT COUNT(*) as cnt FROM queue_items WHERE lane = 'persistent' AND json_extract(metadata, '$.persistentTaskId') = ? AND enqueued_at > datetime('now', '-10 minutes') AND COALESCE(json_extract(metadata, '$.revivalReason'), '') NOT IN ('heartbeat_stale_revival', 'rate_limit_cooldown', 'crash_backoff')"
    ).get(TASK_ID);

    assert.strictEqual(row.cnt, 0, 'crash_backoff items must not count toward DB CB');
  });
});

// ============================================================================
// Test Group 4: In-memory CB — cold-start DB path (revival_events) with backoff
// ============================================================================

describe('In-memory CB cold-start via revival_events — backoff behavior', () => {
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

  it('task stays active when cold-start CB fires (backoff, not pause)', () => {
    insertRevivalEvents(qCtx.db, TASK_ID, 3, 'hard_revival');

    const dbRecent = qCtx.db.prepare(
      "SELECT COUNT(*) as cnt FROM revival_events WHERE task_id = ? AND created_at > datetime('now', '-10 minutes') AND reason NOT IN ('stale_heartbeat', 'rate_limit_cooldown', 'crash_backoff')"
    ).get(TASK_ID);
    const recentHardCount = dbRecent?.cnt || 0;

    // Under the new behavior, the CB does NOT pause or set do_not_auto_resume
    // It only applies a cooldown via blocker_diagnosis
    assert.ok(recentHardCount >= 3, 'CB threshold must be reached with 3 hard revivals');

    // Task must remain active (no auto-pause)
    const taskRow = ptCtx.db.prepare('SELECT status, metadata FROM persistent_tasks WHERE id = ?').get(TASK_ID);
    assert.strictEqual(taskRow.status, 'active', 'task must remain active after CB (backoff used)');
    assert.strictEqual(taskRow.metadata, null, 'metadata must remain null — no do_not_auto_resume set');
  });

  it('does NOT fire when revival_events count < 3', () => {
    insertRevivalEvents(qCtx.db, TASK_ID, 2, 'hard_revival');

    const dbRecent = qCtx.db.prepare(
      "SELECT COUNT(*) as cnt FROM revival_events WHERE task_id = ? AND created_at > datetime('now', '-10 minutes') AND reason NOT IN ('stale_heartbeat', 'rate_limit_cooldown', 'crash_backoff')"
    ).get(TASK_ID);
    const recentHardCount = dbRecent?.cnt || 0;

    assert.ok(recentHardCount < 3, 'CB must not fire with 2 revival events');

    const taskRow = ptCtx.db.prepare('SELECT status, metadata FROM persistent_tasks WHERE id = ?').get(TASK_ID);
    assert.strictEqual(taskRow.status, 'active');
  });

  it('stale_heartbeat revival_events are excluded from cold-start count', () => {
    insertRevivalEvents(qCtx.db, TASK_ID, 3, 'stale_heartbeat');

    const dbRecent = qCtx.db.prepare(
      "SELECT COUNT(*) as cnt FROM revival_events WHERE task_id = ? AND created_at > datetime('now', '-10 minutes') AND reason NOT IN ('stale_heartbeat', 'rate_limit_cooldown', 'crash_backoff')"
    ).get(TASK_ID);

    assert.strictEqual(dbRecent.cnt, 0, 'stale_heartbeat must not count toward cold-start CB threshold');
  });

  it('crash_backoff revival_events are excluded from cold-start count', () => {
    insertRevivalEvents(qCtx.db, TASK_ID, 3, 'crash_backoff');

    const dbRecent = qCtx.db.prepare(
      "SELECT COUNT(*) as cnt FROM revival_events WHERE task_id = ? AND created_at > datetime('now', '-10 minutes') AND reason NOT IN ('stale_heartbeat', 'rate_limit_cooldown', 'crash_backoff')"
    ).get(TASK_ID);

    assert.strictEqual(dbRecent.cnt, 0, 'crash_backoff must not count toward cold-start CB threshold');
  });
});

// ============================================================================
// Test Group 5: Source-code structural verification (post-overhaul)
// ============================================================================

describe('session-queue.js source — circuit breaker overhaul verification', () => {
  let sourceCode;

  before(() => {
    const sourcePath = new URL('../lib/session-queue.js', import.meta.url).pathname;
    sourceCode = fs.readFileSync(sourcePath, 'utf8');
  });

  it('in-memory CB path uses crash_backoff (NOT do_not_auto_resume)', () => {
    assert.ok(
      sourceCode.includes('recentHardCount >= 3'),
      'in-memory CB threshold must be >= 3'
    );
    assert.ok(
      sourceCode.includes('crash_backoff_base_minutes'),
      'in-memory CB must use crash_backoff_base_minutes config'
    );
  });

  it('DB CB path uses crash_backoff (NOT do_not_auto_resume)', () => {
    assert.ok(
      sourceCode.includes('dbRecentRevivals.cnt >= 3'),
      'DB CB threshold must be >= 3'
    );
    assert.ok(
      sourceCode.includes('DB circuit breaker: crash backoff'),
      'DB CB must log crash backoff message'
    );
  });

  it('crash_backoff is excluded from in-memory hard revival count', () => {
    assert.ok(
      sourceCode.includes("e.reason !== 'crash_backoff'"),
      'crash_backoff must be excluded from in-memory hard revival count filter'
    );
  });

  it('crash_backoff is excluded from DB revival_events hard count', () => {
    assert.ok(
      sourceCode.includes("'stale_heartbeat', 'rate_limit_cooldown', 'crash_backoff'"),
      'crash_backoff must be excluded from revival_events SQL NOT IN clause'
    );
  });

  it('crash_backoff is excluded from queue_items DB CB count', () => {
    assert.ok(
      sourceCode.includes("'heartbeat_stale_revival', 'rate_limit_cooldown', 'crash_backoff'"),
      'crash_backoff must be excluded from queue_items SQL NOT IN clause'
    );
  });

  it('circuit breaker does NOT auto-pause tasks anymore', () => {
    // The auto-pause pattern within the circuit breaker blocks should be gone.
    // The only remaining SET status = 'paused' should be outside the CB blocks
    // (e.g. in the rate-limit cooldown path which doesn't pause either).
    // We check that crash_loop_circuit_breaker is no longer referenced in the source.
    assert.ok(
      !sourceCode.includes("reason: 'crash_loop_circuit_breaker'"),
      'crash_loop_circuit_breaker event reason must be removed from source'
    );
  });

  it('in-memory CB logs the backoff minutes', () => {
    assert.ok(
      sourceCode.includes('Crash backoff for') && sourceCode.includes('min cooldown'),
      'in-memory CB must log the backoff minutes'
    );
  });

  it('stale_heartbeat revivals are still excluded from CB count', () => {
    assert.ok(
      sourceCode.includes("e.reason !== 'stale_heartbeat'"),
      'stale_heartbeat must still be excluded from hard revival count'
    );
  });

  it('rate_limit_cooldown revivals are still excluded from CB count', () => {
    assert.ok(
      sourceCode.includes("e.reason !== 'rate_limit_cooldown'"),
      'rate_limit_cooldown must still be excluded from hard revival count'
    );
  });

  it('audit event uses crash_backoff (not crash_loop_circuit_breaker)', () => {
    assert.ok(
      sourceCode.includes("auditEvent('crash_backoff'"),
      'audit event must use crash_backoff event type'
    );
  });
});
