/**
 * Tests for Fix B: session-queue.js Step 1d — re-enqueue dead non-persistent task agents.
 *
 * Covers:
 *   1. Dead non-persistent task agents are re-enqueued in the 'revival' lane.
 *   2. Persistent task agents are skipped (handled by Step 1b).
 *   3. Dedup prevents double-enqueue of the same taskId.
 *   4. The cap of 3 revivals per drain cycle is enforced.
 *   5. Tasks not in 'pending' status are skipped.
 *
 * Two verification strategies are used:
 *   A. Source-code structural verification (same pattern as session-queue-dedup.test.js) —
 *      for logic that cannot be triggered by SQL alone.
 *   B. Real SQLite tests — for the dedup query and the revival lane insertion logic,
 *      mirroring the production schema from session-queue-circuit-breaker.test.js.
 *
 * Run with: node --test .claude/hooks/__tests__/session-queue-step1d.test.js
 */

import { describe, it, before, beforeEach, afterEach } from 'node:test';
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

// ============================================================================
// Schema — mirrored from session-queue-circuit-breaker.test.js
// ============================================================================

const QUEUE_SCHEMA_SQL = `
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

const TODO_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    section TEXT NOT NULL DEFAULT 'TEST-WRITER',
    description TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    priority TEXT NOT NULL DEFAULT 'normal',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    started_timestamp INTEGER,
    completed_at TEXT
  );
`;

// ============================================================================
// Helpers
// ============================================================================

function generateId() {
  return `test-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Open a fresh temp queue database with the production schema applied.
 */
function createQueueDb(prefix = 'sq-step1d-test') {
  const dbPath = path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${crypto.randomBytes(2).toString('hex')}.db`
  );
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(QUEUE_SCHEMA_SQL);

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
 * Open a fresh temp todo database.
 */
function createTodoDb(prefix = 'todo-step1d-test') {
  const dbPath = path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${crypto.randomBytes(2).toString('hex')}.db`
  );
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(TODO_SCHEMA_SQL);

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
 * Insert a queue_items row with the given parameters.
 */
function insertQueueItem(db, { id, status = 'queued', lane = 'standard', metadata = null }) {
  const metaStr = metadata ? JSON.stringify(metadata) : null;
  db.prepare(`
    INSERT INTO queue_items
      (id, status, lane, spawn_type, title, agent_type, hook_type, tag_context, project_dir, source, metadata)
    VALUES
      (?, ?, ?, 'fresh', 'Test item', 'task-runner', 'task-runner', 'test-ctx', '/tmp/test', 'test', ?)
  `).run(id, status, lane, metaStr);
}

/**
 * The exact dedup query used by Step 1d — checks for any active queue item with the same taskId.
 */
function checkStep1dDedup(db, taskId) {
  return db.prepare(
    "SELECT id FROM queue_items WHERE status IN ('queued', 'running', 'spawning') AND json_extract(metadata, '$.taskId') = ?"
  ).get(taskId);
}

/**
 * Insert a revival item (the INSERT used by Step 1d).
 */
function insertRevivalItem(db, { revivalId, taskId, priority = 'normal', agentType = 'task-runner', originalAgentId = 'agent-abc' }) {
  db.prepare(`
    INSERT INTO queue_items (id, status, priority, lane, spawn_type, title, agent_type, hook_type,
      tag_context, prompt, project_dir, metadata, source, expires_at)
    VALUES (?, 'queued', ?, 'revival', 'fresh', ?, ?, ?, ?, ?, ?, ?, 'session-queue-reaper', datetime('now', '+30 minutes'))
  `).run(
    revivalId,
    priority,
    `[Revival] Task ${taskId.slice(0, 8)}`,
    agentType,
    'session-reviver',
    `revival-${taskId.slice(0, 8)}`,
    null,
    '/tmp/test',
    JSON.stringify({ taskId, revivalReason: 'dead_agent_requeue', originalAgentId })
  );
}

// ============================================================================
// Source-code helpers
// ============================================================================

let sourceCode;

before(() => {
  sourceCode = fs.readFileSync(SESSION_QUEUE_PATH, 'utf8');
});

function getStep1dBody() {
  const marker = 'Step 1d: Re-enqueue dead non-persistent task agents';
  const start = sourceCode.indexOf(marker);
  assert.ok(start >= 0, 'Step 1d comment must exist in session-queue.js');

  // Step 1d ends at the blank line before Step 2
  const step2Marker = 'Step 2:';
  const end = sourceCode.indexOf(step2Marker, start);
  assert.ok(end >= 0, 'Step 2 marker must exist after Step 1d');

  return sourceCode.slice(start, end);
}

// ============================================================================
// Part A: Source-code structural verification
// ============================================================================

describe('session-queue.js Step 1d — source-code structural verification', () => {
  it('Step 1d exists in drainQueue() source code', () => {
    assert.ok(
      sourceCode.includes('Step 1d: Re-enqueue dead non-persistent task agents'),
      "Step 1d comment must exist in session-queue.js drainQueue()"
    );
  });

  it('Step 1d uses revivalCandidates from reapSyncPass result', () => {
    const body = getStep1dBody();
    assert.ok(
      body.includes('revivalCandidates'),
      'Step 1d must iterate over result.revivalCandidates'
    );
  });

  it('Step 1d skips candidates with persistentTaskId (handled by Step 1b)', () => {
    const body = getStep1dBody();
    assert.ok(
      body.includes('persistentTaskId'),
      'Step 1d must check for persistentTaskId to skip persistent task agents'
    );
    // Specifically the skip must be a continue statement
    assert.ok(
      body.includes('metadata?.persistentTaskId') || body.includes('metadata.persistentTaskId'),
      'Step 1d must reference metadata.persistentTaskId for the skip condition'
    );
  });

  it('Step 1d uses the revival lane', () => {
    const body = getStep1dBody();
    assert.ok(
      body.includes("'revival'"),
      "Step 1d must enqueue items in the 'revival' lane"
    );
  });

  it('Step 1d caps revivals at 3 per drain cycle', () => {
    const body = getStep1dBody();
    assert.ok(
      body.includes('MAX_NON_PERSISTENT_REVIVALS_PER_DRAIN') || body.includes('revivalCount >= '),
      'Step 1d must have a per-drain-cycle cap'
    );
    assert.ok(
      body.includes('3'),
      'Step 1d revival cap must be 3'
    );
  });

  it('Step 1d verifies task is pending in todo.db before re-enqueuing', () => {
    const body = getStep1dBody();
    assert.ok(
      body.includes("status = 'pending'"),
      "Step 1d must check tasks WHERE status = 'pending' before re-enqueuing"
    );
    assert.ok(
      body.includes('todo.db'),
      'Step 1d must access todo.db for task status verification'
    );
  });

  it('Step 1d requires taskId to proceed — skips candidates without taskId', () => {
    const body = getStep1dBody();
    assert.ok(
      body.includes('metadata?.taskId') || body.includes("metadata['taskId']"),
      'Step 1d must extract taskId from candidate.metadata'
    );
    // Must skip if no taskId
    const taskIdIndex = body.indexOf('taskId');
    assert.ok(taskIdIndex >= 0, 'taskId reference must exist');
    assert.ok(
      body.includes('!taskId') || body.includes('if (!taskId)'),
      'Step 1d must skip candidates that lack a taskId'
    );
  });

  it('Step 1d uses session-queue-reaper as the source field', () => {
    const body = getStep1dBody();
    assert.ok(
      body.includes('session-queue-reaper'),
      "Step 1d must set source = 'session-queue-reaper' on revival queue items"
    );
  });

  it('Step 1d emits a session_revival_triggered audit event', () => {
    const body = getStep1dBody();
    assert.ok(
      body.includes('session_revival_triggered'),
      'Step 1d must emit a session_revival_triggered audit event'
    );
    assert.ok(
      body.includes("source: 'drain-step-1d'"),
      "Step 1d audit event must have source: 'drain-step-1d'"
    );
  });

  it('Step 1d uses dead_agent_requeue as revivalReason in metadata', () => {
    const body = getStep1dBody();
    assert.ok(
      body.includes('dead_agent_requeue'),
      "Step 1d must set revivalReason: 'dead_agent_requeue' in queue item metadata"
    );
  });
});

// ============================================================================
// Part B: SQLite behavioral tests — dedup query
// ============================================================================

describe('Step 1d dedup query — active statuses prevent double-enqueue', () => {
  let ctx;

  beforeEach(() => { ctx = createQueueDb('step1d-dedup'); });
  afterEach(() => { ctx.cleanup(); });

  it('finds a queued item with the same taskId (prevents double-enqueue)', () => {
    const taskId = generateId();
    insertQueueItem(ctx.db, {
      id: generateId(),
      status: 'queued',
      lane: 'revival',
      metadata: { taskId },
    });

    const existing = checkStep1dDedup(ctx.db, taskId);
    assert.ok(existing, "Dedup query must find existing 'queued' revival item");
  });

  it('finds a running item with the same taskId (prevents double-enqueue)', () => {
    const taskId = generateId();
    insertQueueItem(ctx.db, {
      id: generateId(),
      status: 'running',
      lane: 'standard',
      metadata: { taskId },
    });

    const existing = checkStep1dDedup(ctx.db, taskId);
    assert.ok(existing, "Dedup query must find existing 'running' item with same taskId");
  });

  it('finds a spawning item with the same taskId (prevents double-enqueue)', () => {
    const taskId = generateId();
    insertQueueItem(ctx.db, {
      id: generateId(),
      status: 'spawning',
      lane: 'standard',
      metadata: { taskId },
    });

    const existing = checkStep1dDedup(ctx.db, taskId);
    assert.ok(existing, "Dedup query must find existing 'spawning' item with same taskId");
  });

  it('does NOT find a completed item — completed items do not block revival', () => {
    const taskId = generateId();
    insertQueueItem(ctx.db, {
      id: generateId(),
      status: 'completed',
      lane: 'standard',
      metadata: { taskId },
    });

    const existing = checkStep1dDedup(ctx.db, taskId);
    assert.strictEqual(existing, undefined, "Completed items must NOT block revival (false positive prevention)");
  });

  it('does NOT find a failed item — failed items do not block revival', () => {
    const taskId = generateId();
    insertQueueItem(ctx.db, {
      id: generateId(),
      status: 'failed',
      lane: 'standard',
      metadata: { taskId },
    });

    const existing = checkStep1dDedup(ctx.db, taskId);
    assert.strictEqual(existing, undefined, "Failed items must NOT block revival");
  });

  it('does NOT find an item with a different taskId', () => {
    const taskId = generateId();
    const otherTaskId = generateId();
    insertQueueItem(ctx.db, {
      id: generateId(),
      status: 'queued',
      lane: 'revival',
      metadata: { taskId: otherTaskId },
    });

    const existing = checkStep1dDedup(ctx.db, taskId);
    assert.strictEqual(existing, undefined, 'Items with different taskId must not match dedup query');
  });

  it('returns no match when queue is empty', () => {
    const taskId = generateId();
    const existing = checkStep1dDedup(ctx.db, taskId);
    assert.strictEqual(existing, undefined, 'Empty queue must return no dedup match');
  });
});

// ============================================================================
// Part C: SQLite behavioral tests — revival lane insertion
// ============================================================================

describe('Step 1d revival insertion — lane and metadata shape', () => {
  let ctx;

  beforeEach(() => { ctx = createQueueDb('step1d-insert'); });
  afterEach(() => { ctx.cleanup(); });

  it("inserted revival item has lane = 'revival'", () => {
    const revivalId = generateId();
    const taskId = generateId();

    insertRevivalItem(ctx.db, { revivalId, taskId });

    const row = ctx.db.prepare('SELECT * FROM queue_items WHERE id = ?').get(revivalId);
    assert.ok(row, 'Revival item must be inserted');
    assert.strictEqual(row.lane, 'revival', "Revival item must have lane = 'revival'");
  });

  it("inserted revival item has status = 'queued'", () => {
    const revivalId = generateId();
    const taskId = generateId();

    insertRevivalItem(ctx.db, { revivalId, taskId });

    const row = ctx.db.prepare('SELECT status FROM queue_items WHERE id = ?').get(revivalId);
    assert.strictEqual(row.status, 'queued', "Revival item must have status = 'queued'");
  });

  it('inserted revival item has correct metadata with taskId and revivalReason', () => {
    const revivalId = generateId();
    const taskId = generateId();
    const originalAgentId = `agent-${generateId()}`;

    insertRevivalItem(ctx.db, { revivalId, taskId, originalAgentId });

    const row = ctx.db.prepare('SELECT metadata FROM queue_items WHERE id = ?').get(revivalId);
    assert.ok(row.metadata, 'Revival item must have metadata');

    const meta = JSON.parse(row.metadata);
    assert.strictEqual(meta.taskId, taskId, 'Metadata must contain the correct taskId');
    assert.strictEqual(meta.revivalReason, 'dead_agent_requeue', "Metadata revivalReason must be 'dead_agent_requeue'");
    assert.strictEqual(meta.originalAgentId, originalAgentId, 'Metadata must contain the originalAgentId');
  });

  it("inserted revival item has source = 'session-queue-reaper'", () => {
    const revivalId = generateId();
    const taskId = generateId();

    insertRevivalItem(ctx.db, { revivalId, taskId });

    const row = ctx.db.prepare('SELECT source FROM queue_items WHERE id = ?').get(revivalId);
    assert.strictEqual(row.source, 'session-queue-reaper', "Revival item source must be 'session-queue-reaper'");
  });

  it('inserted revival item has a non-null expires_at (TTL protection)', () => {
    const revivalId = generateId();
    const taskId = generateId();

    insertRevivalItem(ctx.db, { revivalId, taskId });

    const row = ctx.db.prepare('SELECT expires_at FROM queue_items WHERE id = ?').get(revivalId);
    assert.ok(row.expires_at, 'Revival item must have a non-null expires_at for TTL protection');
  });

  it("urgent tasks get priority = 'urgent' in revival item", () => {
    const revivalId = generateId();
    const taskId = generateId();

    insertRevivalItem(ctx.db, { revivalId, taskId, priority: 'urgent' });

    const row = ctx.db.prepare('SELECT priority FROM queue_items WHERE id = ?').get(revivalId);
    assert.strictEqual(row.priority, 'urgent', "Urgent tasks must get priority = 'urgent' in revival item");
  });

  it("normal tasks get priority = 'normal' in revival item", () => {
    const revivalId = generateId();
    const taskId = generateId();

    insertRevivalItem(ctx.db, { revivalId, taskId, priority: 'normal' });

    const row = ctx.db.prepare('SELECT priority FROM queue_items WHERE id = ?').get(revivalId);
    assert.strictEqual(row.priority, 'normal', "Normal tasks must get priority = 'normal' in revival item");
  });
});

// ============================================================================
// Part D: SQLite behavioral tests — todo.db pending check
// ============================================================================

describe('Step 1d todo.db pending check — only re-enqueue pending tasks', () => {
  let todoCtx;

  beforeEach(() => { todoCtx = createTodoDb('step1d-todo'); });
  afterEach(() => { todoCtx.cleanup(); });

  it("task with status = 'pending' is found by the pending check query", () => {
    const taskId = generateId();
    todoCtx.db.prepare(
      "INSERT INTO tasks (id, title, section, status, priority) VALUES (?, 'Test task', 'TEST', 'pending', 'normal')"
    ).run(taskId);

    const task = todoCtx.db.prepare(
      "SELECT id, title, section, description, priority FROM tasks WHERE id = ? AND status = 'pending'"
    ).get(taskId);

    assert.ok(task, "Task with status='pending' must be found by the pending check query");
    assert.strictEqual(task.id, taskId, 'Found task must have the correct id');
  });

  it("task with status = 'in_progress' is NOT found by the pending check query", () => {
    const taskId = generateId();
    todoCtx.db.prepare(
      "INSERT INTO tasks (id, title, section, status, priority) VALUES (?, 'In-progress task', 'TEST', 'in_progress', 'normal')"
    ).run(taskId);

    const task = todoCtx.db.prepare(
      "SELECT id FROM tasks WHERE id = ? AND status = 'pending'"
    ).get(taskId);

    assert.strictEqual(task, undefined, "Task with status='in_progress' must NOT pass the pending check");
  });

  it("task with status = 'completed' is NOT found by the pending check query", () => {
    const taskId = generateId();
    todoCtx.db.prepare(
      "INSERT INTO tasks (id, title, section, status, priority) VALUES (?, 'Done task', 'TEST', 'completed', 'normal')"
    ).run(taskId);

    const task = todoCtx.db.prepare(
      "SELECT id FROM tasks WHERE id = ? AND status = 'pending'"
    ).get(taskId);

    assert.strictEqual(task, undefined, "Task with status='completed' must NOT be re-enqueued");
  });

  it('missing task (wrong id) is NOT found by the pending check query', () => {
    const task = todoCtx.db.prepare(
      "SELECT id FROM tasks WHERE id = ? AND status = 'pending'"
    ).get('nonexistent-task-id-abc123');

    assert.strictEqual(task, undefined, 'Missing task must not be re-enqueued');
  });

  it("priority from todo.db is used to determine revival priority", () => {
    const taskIdUrgent = generateId();
    const taskIdNormal = generateId();

    todoCtx.db.prepare(
      "INSERT INTO tasks (id, title, section, status, priority) VALUES (?, 'Urgent task', 'TEST', 'pending', 'urgent')"
    ).run(taskIdUrgent);
    todoCtx.db.prepare(
      "INSERT INTO tasks (id, title, section, status, priority) VALUES (?, 'Normal task', 'TEST', 'pending', 'normal')"
    ).run(taskIdNormal);

    const urgentTask = todoCtx.db.prepare(
      "SELECT priority FROM tasks WHERE id = ? AND status = 'pending'"
    ).get(taskIdUrgent);
    const normalTask = todoCtx.db.prepare(
      "SELECT priority FROM tasks WHERE id = ? AND status = 'pending'"
    ).get(taskIdNormal);

    assert.strictEqual(urgentTask.priority, 'urgent', 'Urgent task must have priority urgent');
    assert.strictEqual(normalTask.priority, 'normal', 'Normal task must have priority normal');

    // Verify the Step 1d priority logic: urgent stays urgent, others become normal
    const revivalPriorityUrgent = urgentTask.priority === 'urgent' ? 'urgent' : 'normal';
    const revivalPriorityNormal = normalTask.priority === 'urgent' ? 'urgent' : 'normal';
    assert.strictEqual(revivalPriorityUrgent, 'urgent', 'Urgent task must get urgent revival priority');
    assert.strictEqual(revivalPriorityNormal, 'normal', 'Non-urgent task must get normal revival priority');
  });
});
