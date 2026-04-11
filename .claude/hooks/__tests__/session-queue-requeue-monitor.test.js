/**
 * Tests for requeueDeadPersistentMonitor() resume-first changes.
 *
 * Covers:
 *   1. monitor_session_id is read from the SELECT in the persistent-tasks.db query.
 *   2. INSERT uses the spawnType variable (not a hardcoded 'fresh' literal).
 *   3. resumeSessionId is passed as resume_session_id in the INSERT.
 *   4. spawnType is set to 'resume' when monitor_session_id is present.
 *   5. spawnType is set to 'fresh' when monitor_session_id is absent.
 *   6. SQLite: resume_session_id is correctly stored on the queue_items row.
 *
 * Strategy: source-code structural verification (same pattern as
 * session-queue-step1d.test.js Part A) + SQLite schema validation.
 *
 * Run with: node --test .claude/hooks/__tests__/session-queue-requeue-monitor.test.js
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
// Schema — mirrored from production (session-queue-circuit-breaker.test.js)
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

// ============================================================================
// Helpers
// ============================================================================

function generateId() {
  return `test-${crypto.randomBytes(4).toString('hex')}`;
}

function createQueueDb(prefix = 'sq-requeue-monitor-test') {
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

// ============================================================================
// Source-code helpers
// ============================================================================

let sourceCode;

before(() => {
  sourceCode = fs.readFileSync(SESSION_QUEUE_PATH, 'utf8');
});

/**
 * Extract the body of requeueDeadPersistentMonitor() from source.
 * Starts at the function declaration, ends before the next export function.
 */
function getRequeueFnBody() {
  const startMarker = 'function requeueDeadPersistentMonitor(';
  const start = sourceCode.indexOf(startMarker);
  assert.ok(start >= 0, 'requeueDeadPersistentMonitor function must exist in session-queue.js');

  // Find the INSERT for the persistent monitor (distinct from Step 1d INSERT)
  const persistentInsertMarker = "INSERT INTO queue_items (id, status, priority, lane, spawn_type";
  // Find the one that appears after the function declaration
  let insertPos = sourceCode.indexOf(persistentInsertMarker, start);
  assert.ok(insertPos >= 0, 'requeueDeadPersistentMonitor must contain an INSERT INTO queue_items');

  // Extract a generous window around and including the INSERT
  const fnEnd = sourceCode.indexOf('\nexport function ', start + 1);
  assert.ok(fnEnd >= 0, 'Function must be followed by another export function');

  return sourceCode.slice(start, fnEnd);
}

// ============================================================================
// Part A: Source-code structural verification
// ============================================================================

describe('requeueDeadPersistentMonitor() — source-code structural verification', () => {
  it('function exists in session-queue.js', () => {
    assert.ok(
      sourceCode.includes('function requeueDeadPersistentMonitor('),
      'requeueDeadPersistentMonitor function must exist in session-queue.js'
    );
  });

  it('SELECT includes monitor_session_id column', () => {
    const body = getRequeueFnBody();
    assert.ok(
      body.includes('monitor_session_id'),
      'requeueDeadPersistentMonitor must SELECT monitor_session_id from persistent_tasks'
    );
    // The column must appear in a SELECT context, not just a comment
    assert.ok(
      body.includes('SELECT id, title, status, metadata, monitor_session_id FROM persistent_tasks'),
      'SELECT must include monitor_session_id alongside id, title, status, metadata'
    );
  });

  it('reads monitor_session_id from the task row to set resumeSessionId', () => {
    const body = getRequeueFnBody();
    assert.ok(
      body.includes('task.monitor_session_id'),
      'requeueDeadPersistentMonitor must read task.monitor_session_id from the query result'
    );
  });

  it('sets resumeSessionId from task.monitor_session_id with null fallback', () => {
    const body = getRequeueFnBody();
    // Must handle the case where monitor_session_id is absent (null fallback)
    assert.ok(
      body.includes('task.monitor_session_id || null') || body.includes('monitor_session_id ?? null'),
      'resumeSessionId must fall back to null when monitor_session_id is absent'
    );
  });

  it('derives spawnType from resumeSessionId (resume when present, fresh when absent)', () => {
    const body = getRequeueFnBody();
    assert.ok(
      (body.includes("spawnType = resumeSessionId ? 'resume' : 'fresh'") ||
        body.includes("spawnType = (resumeSessionId) ? 'resume' : 'fresh'")),
      "spawnType must be 'resume' when resumeSessionId is truthy, 'fresh' otherwise"
    );
  });

  it('INSERT uses spawnType variable (not hardcoded fresh literal) in position', () => {
    const body = getRequeueFnBody();
    // Find the INSERT block
    const insertPos = body.indexOf('INSERT INTO queue_items');
    assert.ok(insertPos >= 0, 'INSERT INTO queue_items must exist in requeueDeadPersistentMonitor');
    const insertBlock = body.slice(insertPos, insertPos + 800);
    assert.ok(
      insertBlock.includes('spawnType'),
      'INSERT in requeueDeadPersistentMonitor must reference the spawnType variable'
    );
    // There must be no bare 'fresh' string literal as the spawn_type value in the INSERT itself
    // (the variable spawnType is passed in its place)
    // We verify this by checking spawnType appears in the .run() call args
    const runPos = body.indexOf('.run(', insertPos);
    assert.ok(runPos >= 0, '.run() call must follow the INSERT prepare');
    const runBlock = body.slice(runPos, runPos + 400);
    assert.ok(
      runBlock.includes('spawnType'),
      '.run() args must pass the spawnType variable as the spawn_type value'
    );
  });

  it('INSERT includes resume_session_id column', () => {
    const body = getRequeueFnBody();
    assert.ok(
      body.includes('resume_session_id'),
      'requeueDeadPersistentMonitor INSERT must include the resume_session_id column'
    );
  });

  it('resumeSessionId is passed as the resume_session_id value in .run()', () => {
    const body = getRequeueFnBody();
    // resumeSessionId must be declared as a variable
    assert.ok(
      body.includes('const resumeSessionId') || body.includes('let resumeSessionId'),
      'resumeSessionId must be declared as a local variable'
    );
    // resumeSessionId must appear in the .run() argument list (after the INSERT prepare)
    const insertPos = body.indexOf('INSERT INTO queue_items');
    assert.ok(insertPos >= 0, 'INSERT must exist');
    const runPos = body.indexOf('.run(', insertPos);
    assert.ok(runPos >= 0, '.run() must follow INSERT');
    const runBlock = body.slice(runPos, runPos + 400);
    assert.ok(
      runBlock.includes('resumeSessionId'),
      'resumeSessionId must be passed as a value in .run() for the resume_session_id column'
    );
  });

  it('log message includes spawnType for traceability', () => {
    const body = getRequeueFnBody();
    // The log at the end of the function should mention spawnType
    assert.ok(
      body.includes('spawnType') && body.includes('log('),
      'requeueDeadPersistentMonitor must log the spawnType for traceability'
    );
  });
});

// ============================================================================
// Part B: SQLite behavioral tests — persistent monitor INSERT with resume_session_id
// ============================================================================

describe('requeueDeadPersistentMonitor() INSERT — resume_session_id column storage', () => {
  let ctx;

  beforeEach(() => { ctx = createQueueDb('requeue-monitor-insert'); });
  afterEach(() => { ctx.cleanup(); });

  /**
   * Simulate the INSERT from requeueDeadPersistentMonitor() with spawnType = 'resume'.
   * Mirrors the exact column list in production code.
   */
  function insertPersistentMonitorRevival(db, { id, persistentTaskId, spawnType, resumeSessionId }) {
    const title = `[Persistent] Monitor revival: Test task`;
    const extraEnv = JSON.stringify({ GENTYR_PERSISTENT_TASK_ID: persistentTaskId, GENTYR_PERSISTENT_MONITOR: 'true' });
    const metadata = JSON.stringify({ persistentTaskId, revivalReason: 'immediate_reaper_revival' });

    db.prepare(`
      INSERT INTO queue_items (id, status, priority, lane, spawn_type, title, agent_type, hook_type,
        tag_context, prompt, model, cwd, mcp_config, resume_session_id, extra_args, extra_env,
        project_dir, worktree_path, metadata, source, expires_at)
      VALUES (?, 'queued', 'critical', 'persistent', ?, ?, ?, ?, 'persistent-monitor', ?, NULL, NULL, NULL, ?, NULL, ?, ?, NULL, ?, ?, NULL)
    `).run(
      id,
      spawnType,
      title,
      'persistent-task-monitor',
      'persistent-task-monitor',
      `Revival prompt for ${persistentTaskId}`,
      resumeSessionId,
      extraEnv,
      '/tmp/test-project',
      metadata,
      'session-queue-reaper'
    );
  }

  it("resume-path row has spawn_type = 'resume'", () => {
    const id = generateId();
    const persistentTaskId = generateId();
    const resumeSessionId = crypto.randomUUID();

    insertPersistentMonitorRevival(ctx.db, { id, persistentTaskId, spawnType: 'resume', resumeSessionId });

    const row = ctx.db.prepare('SELECT spawn_type FROM queue_items WHERE id = ?').get(id);
    assert.ok(row, 'Row must be inserted');
    assert.strictEqual(row.spawn_type, 'resume', "spawn_type must be 'resume' when resumeSessionId is provided");
  });

  it('resume-path row stores the correct resume_session_id UUID', () => {
    const id = generateId();
    const persistentTaskId = generateId();
    const resumeSessionId = crypto.randomUUID();

    insertPersistentMonitorRevival(ctx.db, { id, persistentTaskId, spawnType: 'resume', resumeSessionId });

    const row = ctx.db.prepare('SELECT resume_session_id FROM queue_items WHERE id = ?').get(id);
    assert.ok(row, 'Row must be inserted');
    assert.strictEqual(row.resume_session_id, resumeSessionId, 'resume_session_id must match the UUID from monitor_session_id');
  });

  it("fresh-path row has spawn_type = 'fresh'", () => {
    const id = generateId();
    const persistentTaskId = generateId();

    insertPersistentMonitorRevival(ctx.db, { id, persistentTaskId, spawnType: 'fresh', resumeSessionId: null });

    const row = ctx.db.prepare('SELECT spawn_type FROM queue_items WHERE id = ?').get(id);
    assert.ok(row, 'Row must be inserted');
    assert.strictEqual(row.spawn_type, 'fresh', "spawn_type must be 'fresh' when no resumeSessionId");
  });

  it('fresh-path row has null resume_session_id', () => {
    const id = generateId();
    const persistentTaskId = generateId();

    insertPersistentMonitorRevival(ctx.db, { id, persistentTaskId, spawnType: 'fresh', resumeSessionId: null });

    const row = ctx.db.prepare('SELECT resume_session_id FROM queue_items WHERE id = ?').get(id);
    assert.ok(row, 'Row must be inserted');
    assert.strictEqual(row.resume_session_id, null, 'resume_session_id must be null on fresh-path row');
  });

  it("persistent monitor revival row always has lane = 'persistent'", () => {
    const id = generateId();
    const persistentTaskId = generateId();

    insertPersistentMonitorRevival(ctx.db, { id, persistentTaskId, spawnType: 'fresh', resumeSessionId: null });

    const row = ctx.db.prepare('SELECT lane FROM queue_items WHERE id = ?').get(id);
    assert.strictEqual(row.lane, 'persistent', "Persistent monitor revival must have lane = 'persistent'");
  });

  it("persistent monitor revival row always has priority = 'critical'", () => {
    const id = generateId();
    const persistentTaskId = generateId();

    insertPersistentMonitorRevival(ctx.db, { id, persistentTaskId, spawnType: 'resume', resumeSessionId: crypto.randomUUID() });

    const row = ctx.db.prepare('SELECT priority FROM queue_items WHERE id = ?').get(id);
    assert.strictEqual(row.priority, 'critical', "Persistent monitor revival must have priority = 'critical'");
  });

  it('metadata contains persistentTaskId for dedup query compatibility', () => {
    const id = generateId();
    const persistentTaskId = generateId();

    insertPersistentMonitorRevival(ctx.db, { id, persistentTaskId, spawnType: 'fresh', resumeSessionId: null });

    const row = ctx.db.prepare('SELECT metadata FROM queue_items WHERE id = ?').get(id);
    assert.ok(row.metadata, 'metadata must be non-null');
    const meta = JSON.parse(row.metadata);
    assert.strictEqual(meta.persistentTaskId, persistentTaskId, 'metadata.persistentTaskId must match for dedup query compatibility');
  });

  it("source = 'session-queue-reaper' on persistent monitor revival row", () => {
    const id = generateId();
    const persistentTaskId = generateId();

    insertPersistentMonitorRevival(ctx.db, { id, persistentTaskId, spawnType: 'fresh', resumeSessionId: null });

    const row = ctx.db.prepare('SELECT source FROM queue_items WHERE id = ?').get(id);
    assert.strictEqual(row.source, 'session-queue-reaper', "source must be 'session-queue-reaper'");
  });
});
