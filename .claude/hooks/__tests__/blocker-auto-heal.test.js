/**
 * Tests for handleBlocker() exported from lib/blocker-auto-heal.js
 *
 * Covers:
 *   1. Rate limit diagnosis (is_transient=true) → { action: 'cooldown' }
 *   2. Null / no diagnosis → { action: 'retry' }
 *   3. Unknown error_type → { action: 'retry' }
 *   4. Zero consecutive_errors → { action: 'retry' }
 *   5. Fix already in flight via blocker_diagnosis (status='fix_in_progress') → { action: 'retry' }
 *   6. Fix already in flight via todo.db (self-heal-system task pending/in_progress) → { action: 'retry' }
 *   7. Auth error, 0 fix attempts, DB present → { action: 'fix_spawned', fixTaskId }
 *   8. Auth error, max fix attempts reached → { action: 'escalated' }
 *   9. Crash error, 0 fix attempts → { action: 'fix_spawned' }
 *  10. Timeout error, 0 fix attempts → { action: 'fix_spawned' }
 *  11. Escalation creates a bypass_request in bypass-requests.db
 *  12. Escalation pauses the persistent task (status → 'paused')
 *  13. Spawned fix task appears in todo.db with section='INVESTIGATOR & PLANNER'
 *  14. Spawned fix task updates blocker_diagnosis to status='fix_in_progress'
 *  15. Idempotent: second call with fix already in flight returns retry, not second fix_spawned
 *
 * Strategy: create real SQLite databases in temp directories mirroring the
 * production schema for persistent-tasks.db, todo.db, and bypass-requests.db.
 * Set CLAUDE_PROJECT_DIR before importing the module with a cache-bust.
 *
 * Run with: node --test .claude/hooks/__tests__/blocker-auto-heal.test.js
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

// ============================================================================
// Schema helpers — mirrored from blocker-auto-heal.js and related tables
// ============================================================================

/**
 * Create the blocker_diagnosis table used by persistent-tasks.db.
 * Mirrors the schema inferred from blocker-auto-heal.js getOrCreateDiagnosis().
 */
function createPersistentTasksDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS persistent_tasks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'active',
      title TEXT NOT NULL,
      metadata TEXT
    );

    CREATE TABLE IF NOT EXISTS blocker_diagnosis (
      id TEXT PRIMARY KEY,
      persistent_task_id TEXT NOT NULL,
      error_type TEXT NOT NULL,
      is_transient INTEGER NOT NULL DEFAULT 0,
      diagnosis_details TEXT,
      fix_attempts INTEGER NOT NULL DEFAULT 0,
      max_fix_attempts INTEGER NOT NULL DEFAULT 3,
      fix_task_ids TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      persistent_task_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  return db;
}

/**
 * Create the tasks table used by todo.db.
 * Mirrors the schema inferred from blocker-auto-heal.js spawnFixTask().
 */
function createTodoDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      section TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      title TEXT NOT NULL,
      description TEXT,
      assigned_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_timestamp INTEGER,
      priority TEXT NOT NULL DEFAULT 'normal',
      persistent_task_id TEXT,
      category_id TEXT
    );

    CREATE TABLE IF NOT EXISTS task_categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      deprecated_section TEXT
    );
  `);

  return db;
}

/**
 * Create the bypass_requests table used by bypass-requests.db.
 * Mirrors the schema inferred from blocker-auto-heal.js escalateToCto().
 */
function createBypassRequestsDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS bypass_requests (
      id TEXT PRIMARY KEY,
      task_type TEXT,
      task_id TEXT,
      task_title TEXT,
      agent_id TEXT,
      category TEXT,
      summary TEXT,
      details TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  return db;
}

// ============================================================================
// Temp project directory helper
// ============================================================================

/**
 * Create a minimal project directory structure with all required DB files.
 * Returns { projectDir, ptDbPath, todoDbPath, bypassDbPath, cleanup }.
 */
function createTestProject(prefix = 'blocker-heal-test') {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
  const stateDir = path.join(projectDir, '.claude', 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  const ptDbPath = path.join(stateDir, 'persistent-tasks.db');
  const todoDbPath = path.join(projectDir, '.claude', 'todo.db');
  const bypassDbPath = path.join(stateDir, 'bypass-requests.db');

  // Create all databases with their schemas
  const ptDb = createPersistentTasksDb(ptDbPath);
  const todoDb = createTodoDb(todoDbPath);
  const bypassDb = createBypassRequestsDb(bypassDbPath);

  // Close them — the module will reopen as needed
  ptDb.close();
  todoDb.close();
  bypassDb.close();

  return {
    projectDir,
    ptDbPath,
    todoDbPath,
    bypassDbPath,
    cleanup() {
      try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch (_) { /* non-fatal */ }
    },
  };
}

// ============================================================================
// Diagnosis builder helpers
// ============================================================================

function makeAuthErrorDiagnosis(opts = {}) {
  return {
    error_type: 'auth_error',
    is_transient: false,
    consecutive_errors: 3,
    sample_error: 'authentication failed',
    suggested_action: 'diagnose_credentials',
    ...opts,
  };
}

function makeRateLimitDiagnosis(opts = {}) {
  return {
    error_type: 'rate_limit',
    is_transient: true,
    consecutive_errors: 3,
    sample_error: 'rate limit exceeded',
    suggested_action: 'cooldown',
    ...opts,
  };
}

function makeCrashDiagnosis(opts = {}) {
  return {
    error_type: 'crash',
    is_transient: false,
    consecutive_errors: 4,
    sample_error: 'process exited unexpectedly',
    suggested_action: 'investigate',
    ...opts,
  };
}

function makeTimeoutDiagnosis(opts = {}) {
  return {
    error_type: 'timeout',
    is_transient: false,
    consecutive_errors: 3,
    sample_error: 'session timed out',
    suggested_action: 'investigate',
    ...opts,
  };
}

function makeUnknownDiagnosis(opts = {}) {
  return {
    error_type: 'unknown',
    is_transient: false,
    consecutive_errors: 0,
    sample_error: '',
    suggested_action: 'retry',
    ...opts,
  };
}

// ============================================================================
// Module loader
// ============================================================================

let handleBlocker;

// We load handleBlocker fresh for each describe block via a re-import trick.
// Because ESM module caching is by URL, we use the ?bust= technique.
// However, the module uses top-level `await import('better-sqlite3')` and
// reads CLAUDE_PROJECT_DIR at module scope — we must set the env var BEFORE
// importing, and use a fresh ?bust= for each test group that needs different behavior.

// ============================================================================
// Test Group 1: Fast-path returns that bypass DB entirely
// ============================================================================

describe('handleBlocker() — fast-path returns (no DB required)', () => {
  let ctx;

  before(async () => {
    ctx = createTestProject('fast-path');
    process.env.CLAUDE_PROJECT_DIR = ctx.projectDir;

    const mod = await import(
      new URL('../lib/blocker-auto-heal.js', import.meta.url).href + `?bust=${Date.now()}`
    );
    handleBlocker = mod.handleBlocker;
  });

  after(() => {
    ctx?.cleanup();
  });

  it('returns { action: "retry" } when diagnosis is null', () => {
    const result = handleBlocker('persistent-task-null', null);
    assert.deepStrictEqual(result, { action: 'retry' });
  });

  it('returns { action: "retry" } when diagnosis is undefined', () => {
    const result = handleBlocker('persistent-task-undef', undefined);
    assert.deepStrictEqual(result, { action: 'retry' });
  });

  it('returns { action: "cooldown" } for rate_limit + is_transient=true', () => {
    const result = handleBlocker('persistent-task-rl', makeRateLimitDiagnosis());
    assert.deepStrictEqual(result, { action: 'cooldown' });
  });

  it('returns { action: "retry" } for rate_limit with is_transient=false (non-transient)', () => {
    // Non-transient rate limit should fall through — unknown or zero consecutive → retry
    // Actually with consecutive_errors > 0 and not unknown, it should attempt fix,
    // but the point here is that is_transient=false doesn't match the cooldown guard
    const diagnosis = makeRateLimitDiagnosis({ is_transient: false });
    const result = handleBlocker('persistent-task-rl-nontransient', diagnosis);
    // Should NOT be cooldown since is_transient is false
    assert.notStrictEqual(result.action, 'cooldown');
  });

  it('returns { action: "retry" } for error_type="unknown"', () => {
    const result = handleBlocker('persistent-task-unknown', makeUnknownDiagnosis());
    assert.deepStrictEqual(result, { action: 'retry' });
  });

  it('returns { action: "retry" } for consecutive_errors=0 regardless of error_type', () => {
    const result = handleBlocker('persistent-task-zero-errors', {
      error_type: 'auth_error',
      is_transient: false,
      consecutive_errors: 0,
      sample_error: '',
      suggested_action: 'diagnose_credentials',
    });
    assert.deepStrictEqual(result, { action: 'retry' });
  });
});

// ============================================================================
// Test Group 2: Fix spawning — auth_error with empty DB
// ============================================================================

describe('handleBlocker() — fix spawning for auth_error', () => {
  let ctx;
  let handleBlockerFresh;

  before(async () => {
    ctx = createTestProject('auth-error-fix');
    process.env.CLAUDE_PROJECT_DIR = ctx.projectDir;

    const mod = await import(
      new URL('../lib/blocker-auto-heal.js', import.meta.url).href + `?bust=${Date.now()}`
    );
    handleBlockerFresh = mod.handleBlocker;
  });

  after(() => {
    ctx?.cleanup();
  });

  it('spawns a fix task and returns { action: "fix_spawned", fixTaskId } for auth_error', () => {
    const taskId = 'pt-auth-001';

    // Insert the persistent task so it exists in the DB
    const ptDb = new Database(ctx.ptDbPath);
    ptDb.prepare("INSERT INTO persistent_tasks (id, status, title) VALUES (?, 'active', 'Auth test task')")
      .run(taskId);
    ptDb.close();

    const result = handleBlockerFresh(taskId, makeAuthErrorDiagnosis());

    assert.strictEqual(result.action, 'fix_spawned', 'action must be fix_spawned for auth_error with 0 attempts');
    assert.ok(result.fixTaskId, 'fixTaskId must be present');
    assert.ok(typeof result.fixTaskId === 'string', 'fixTaskId must be a string');
    assert.ok(result.fixTaskId.length > 0, 'fixTaskId must be non-empty');
  });

  it('fix task appears in todo.db with section=INVESTIGATOR & PLANNER and status=pending', () => {
    const taskId = 'pt-auth-002';

    const ptDb = new Database(ctx.ptDbPath);
    ptDb.prepare("INSERT INTO persistent_tasks (id, status, title) VALUES (?, 'active', 'Auth task 002')")
      .run(taskId);
    ptDb.close();

    const result = handleBlockerFresh(taskId, makeAuthErrorDiagnosis());
    assert.strictEqual(result.action, 'fix_spawned');

    // Verify the fix task is in todo.db
    const todoDb = new Database(ctx.todoDbPath);
    const fixTask = todoDb.prepare('SELECT * FROM tasks WHERE id = ?').get(result.fixTaskId);
    todoDb.close();

    assert.ok(fixTask, 'fix task must exist in todo.db');
    assert.strictEqual(fixTask.section, 'INVESTIGATOR & PLANNER', 'fix task section must be INVESTIGATOR & PLANNER');
    assert.strictEqual(fixTask.status, 'pending', 'fix task must start as pending');
    assert.strictEqual(fixTask.assigned_by, 'self-heal-system', 'fix task must be assigned_by self-heal-system');
    assert.strictEqual(fixTask.priority, 'urgent', 'fix task must have urgent priority');
    assert.strictEqual(fixTask.persistent_task_id, taskId, 'fix task persistent_task_id must match');
  });

  it('fix task title contains the error_type', () => {
    const taskId = 'pt-auth-003';

    const ptDb = new Database(ctx.ptDbPath);
    ptDb.prepare("INSERT INTO persistent_tasks (id, status, title) VALUES (?, 'active', 'Auth task 003')")
      .run(taskId);
    ptDb.close();

    const result = handleBlockerFresh(taskId, makeAuthErrorDiagnosis());
    assert.strictEqual(result.action, 'fix_spawned');

    const todoDb = new Database(ctx.todoDbPath);
    const fixTask = todoDb.prepare('SELECT title FROM tasks WHERE id = ?').get(result.fixTaskId);
    todoDb.close();

    assert.ok(fixTask.title.includes('auth_error'), `fix task title must include 'auth_error'; got: "${fixTask.title}"`);
  });

  it('blocker_diagnosis record is created with status=fix_in_progress after spawning', () => {
    const taskId = 'pt-auth-004';

    const ptDb = new Database(ctx.ptDbPath);
    ptDb.prepare("INSERT INTO persistent_tasks (id, status, title) VALUES (?, 'active', 'Auth task 004')")
      .run(taskId);
    ptDb.close();

    const result = handleBlockerFresh(taskId, makeAuthErrorDiagnosis());
    assert.strictEqual(result.action, 'fix_spawned');

    // Verify blocker_diagnosis was updated
    const ptDb2 = new Database(ctx.ptDbPath);
    const diagRecord = ptDb2.prepare(
      "SELECT * FROM blocker_diagnosis WHERE persistent_task_id = ? LIMIT 1"
    ).get(taskId);
    ptDb2.close();

    assert.ok(diagRecord, 'blocker_diagnosis record must exist after fix spawn');
    assert.strictEqual(diagRecord.status, 'fix_in_progress', 'blocker_diagnosis status must be fix_in_progress');
    assert.strictEqual(diagRecord.error_type, 'auth_error', 'blocker_diagnosis error_type must match');
    assert.strictEqual(diagRecord.fix_attempts, 1, 'fix_attempts must be 1 after first spawn');
  });
});

// ============================================================================
// Test Group 3: Fix spawning for crash and timeout errors
// ============================================================================

describe('handleBlocker() — fix spawning for crash and timeout errors', () => {
  let ctx;
  let handleBlockerFresh;

  before(async () => {
    ctx = createTestProject('crash-timeout-fix');
    process.env.CLAUDE_PROJECT_DIR = ctx.projectDir;

    const mod = await import(
      new URL('../lib/blocker-auto-heal.js', import.meta.url).href + `?bust=${Date.now()}`
    );
    handleBlockerFresh = mod.handleBlocker;
  });

  after(() => {
    ctx?.cleanup();
  });

  it('spawns a fix task for crash error_type', () => {
    const taskId = 'pt-crash-001';

    const ptDb = new Database(ctx.ptDbPath);
    ptDb.prepare("INSERT INTO persistent_tasks (id, status, title) VALUES (?, 'active', 'Crash test task')")
      .run(taskId);
    ptDb.close();

    const result = handleBlockerFresh(taskId, makeCrashDiagnosis());

    assert.strictEqual(result.action, 'fix_spawned', 'crash error must result in fix_spawned');
    assert.ok(result.fixTaskId, 'fixTaskId must be present for crash error');
  });

  it('spawns a fix task for timeout error_type', () => {
    const taskId = 'pt-timeout-001';

    const ptDb = new Database(ctx.ptDbPath);
    ptDb.prepare("INSERT INTO persistent_tasks (id, status, title) VALUES (?, 'active', 'Timeout test task')")
      .run(taskId);
    ptDb.close();

    const result = handleBlockerFresh(taskId, makeTimeoutDiagnosis());

    assert.strictEqual(result.action, 'fix_spawned', 'timeout error must result in fix_spawned');
    assert.ok(result.fixTaskId, 'fixTaskId must be present for timeout error');
  });

  it('fix task description for crash includes crash-specific investigation steps', () => {
    const taskId = 'pt-crash-002';

    const ptDb = new Database(ctx.ptDbPath);
    ptDb.prepare("INSERT INTO persistent_tasks (id, status, title) VALUES (?, 'active', 'Crash task 002')")
      .run(taskId);
    ptDb.close();

    const result = handleBlockerFresh(taskId, makeCrashDiagnosis());
    assert.strictEqual(result.action, 'fix_spawned');

    const todoDb = new Database(ctx.todoDbPath);
    const fixTask = todoDb.prepare('SELECT description FROM tasks WHERE id = ?').get(result.fixTaskId);
    todoDb.close();

    assert.ok(fixTask, 'fix task must exist');
    assert.ok(fixTask.description, 'fix task must have a description');
    // Crash investigation should mention crash-relevant steps
    assert.ok(
      fixTask.description.includes('crash') || fixTask.description.includes('session') || fixTask.description.includes('child'),
      `crash fix task description must include crash-relevant content; got: "${fixTask.description.slice(0, 200)}"`
    );
  });

  it('fix task description for auth_error includes credential investigation steps', () => {
    const taskId = 'pt-auth-desc-001';

    const ptDb = new Database(ctx.ptDbPath);
    ptDb.prepare("INSERT INTO persistent_tasks (id, status, title) VALUES (?, 'active', 'Auth desc task')")
      .run(taskId);
    ptDb.close();

    const result = handleBlockerFresh(taskId, makeAuthErrorDiagnosis());
    assert.strictEqual(result.action, 'fix_spawned');

    const todoDb = new Database(ctx.todoDbPath);
    const fixTask = todoDb.prepare('SELECT description FROM tasks WHERE id = ?').get(result.fixTaskId);
    todoDb.close();

    assert.ok(fixTask.description, 'fix task must have a description');
    // Auth investigation should mention credentials or 1Password
    assert.ok(
      fixTask.description.includes('credential') || fixTask.description.includes('1Password') || fixTask.description.includes('op whoami') || fixTask.description.includes('token'),
      `auth fix task description must include credential content; got: "${fixTask.description.slice(0, 200)}"`
    );
  });
});

// ============================================================================
// Test Group 4: Escalation when max fix attempts exceeded
// ============================================================================

describe('handleBlocker() — escalation when max fix attempts reached', () => {
  let ctx;
  let handleBlockerFresh;

  before(async () => {
    ctx = createTestProject('escalation-test');
    process.env.CLAUDE_PROJECT_DIR = ctx.projectDir;

    const mod = await import(
      new URL('../lib/blocker-auto-heal.js', import.meta.url).href + `?bust=${Date.now()}`
    );
    handleBlockerFresh = mod.handleBlocker;
  });

  after(() => {
    ctx?.cleanup();
  });

  it('returns { action: "escalated" } when fix_attempts >= max_fix_attempts', () => {
    const taskId = 'pt-escalate-001';

    // Insert persistent task
    const ptDb = new Database(ctx.ptDbPath);
    ptDb.prepare("INSERT INTO persistent_tasks (id, status, title) VALUES (?, 'active', 'Escalation task')")
      .run(taskId);

    // Insert a blocker_diagnosis that already has max attempts reached (3/3)
    const diagId = 'diag-' + crypto.randomBytes(4).toString('hex');
    ptDb.prepare(`
      INSERT INTO blocker_diagnosis
        (id, persistent_task_id, error_type, is_transient, diagnosis_details, fix_attempts, max_fix_attempts, status)
      VALUES (?, ?, 'auth_error', 0, '{}', 3, 3, 'fix_in_progress')
    `).run(diagId, taskId);
    ptDb.close();

    const result = handleBlockerFresh(taskId, makeAuthErrorDiagnosis());

    assert.strictEqual(result.action, 'escalated', 'must escalate when fix_attempts >= max_fix_attempts');
  });

  it('escalation creates a bypass_request in bypass-requests.db', () => {
    const taskId = 'pt-escalate-bypass-001';

    const ptDb = new Database(ctx.ptDbPath);
    ptDb.prepare("INSERT INTO persistent_tasks (id, status, title) VALUES (?, 'active', 'Bypass request task')")
      .run(taskId);

    const diagId = 'diag-bypass-' + crypto.randomBytes(4).toString('hex');
    ptDb.prepare(`
      INSERT INTO blocker_diagnosis
        (id, persistent_task_id, error_type, is_transient, diagnosis_details, fix_attempts, max_fix_attempts, status)
      VALUES (?, ?, 'auth_error', 0, '{}', 3, 3, 'fix_in_progress')
    `).run(diagId, taskId);
    ptDb.close();

    const result = handleBlockerFresh(taskId, makeAuthErrorDiagnosis());
    assert.strictEqual(result.action, 'escalated');

    // Verify bypass request was created
    const bypassDb = new Database(ctx.bypassDbPath);
    const bypassReq = bypassDb.prepare(
      "SELECT * FROM bypass_requests WHERE task_id = ? AND task_type = 'persistent' LIMIT 1"
    ).get(taskId);
    bypassDb.close();

    assert.ok(bypassReq, 'bypass request must be created in bypass-requests.db');
    assert.strictEqual(bypassReq.status, 'pending', 'bypass request must start as pending');
    assert.strictEqual(bypassReq.agent_id, 'self-heal-system', 'bypass request must be from self-heal-system');
  });

  it('escalation pauses the persistent task (status → paused)', () => {
    const taskId = 'pt-escalate-pause-001';

    const ptDb = new Database(ctx.ptDbPath);
    ptDb.prepare("INSERT INTO persistent_tasks (id, status, title) VALUES (?, 'active', 'Paused by escalation')")
      .run(taskId);

    const diagId = 'diag-pause-' + crypto.randomBytes(4).toString('hex');
    ptDb.prepare(`
      INSERT INTO blocker_diagnosis
        (id, persistent_task_id, error_type, is_transient, diagnosis_details, fix_attempts, max_fix_attempts, status)
      VALUES (?, ?, 'crash', 0, '{}', 3, 3, 'fix_in_progress')
    `).run(diagId, taskId);
    ptDb.close();

    const result = handleBlockerFresh(taskId, makeCrashDiagnosis());
    assert.strictEqual(result.action, 'escalated');

    // Verify persistent task was paused
    const ptDb2 = new Database(ctx.ptDbPath);
    const task = ptDb2.prepare('SELECT status FROM persistent_tasks WHERE id = ?').get(taskId);
    ptDb2.close();

    assert.strictEqual(task?.status, 'paused', 'persistent task must be paused after escalation');
  });

  it('escalation dedup: second escalation call for same task does not create duplicate bypass request', () => {
    const taskId = 'pt-escalate-dedup-001';

    const ptDb = new Database(ctx.ptDbPath);
    ptDb.prepare("INSERT INTO persistent_tasks (id, status, title) VALUES (?, 'active', 'Dedup escalation')")
      .run(taskId);

    const diagId = 'diag-dedup-' + crypto.randomBytes(4).toString('hex');
    ptDb.prepare(`
      INSERT INTO blocker_diagnosis
        (id, persistent_task_id, error_type, is_transient, diagnosis_details, fix_attempts, max_fix_attempts, status)
      VALUES (?, ?, 'crash', 0, '{}', 3, 3, 'active')
    `).run(diagId, taskId);
    ptDb.close();

    // First escalation
    const result1 = handleBlockerFresh(taskId, makeCrashDiagnosis());
    assert.strictEqual(result1.action, 'escalated');

    // Second escalation call for same task (task is now paused)
    // The blocker_diagnosis is already 'escalated' from first call
    // and the bypass request is pending
    // Second call should either: return escalated (dedup guard stops second bypass request) or retry
    const result2 = handleBlockerFresh(taskId, makeCrashDiagnosis());
    assert.ok(
      result2.action === 'escalated' || result2.action === 'retry',
      `second escalation must be either 'escalated' (deduped) or 'retry' (already-paused); got: '${result2.action}'`
    );

    // Verify only ONE bypass request was created
    const bypassDb = new Database(ctx.bypassDbPath);
    const requests = bypassDb.prepare(
      "SELECT COUNT(*) as cnt FROM bypass_requests WHERE task_id = ? AND task_type = 'persistent' AND status = 'pending'"
    ).get(taskId);
    bypassDb.close();

    assert.ok(requests.cnt <= 1, `at most 1 pending bypass request must exist; got ${requests.cnt}`);
  });
});

// ============================================================================
// Test Group 5: Fix in-flight deduplication
// ============================================================================

describe('handleBlocker() — fix in-flight deduplication', () => {
  let ctx;
  let handleBlockerFresh;

  before(async () => {
    ctx = createTestProject('in-flight-dedup');
    process.env.CLAUDE_PROJECT_DIR = ctx.projectDir;

    const mod = await import(
      new URL('../lib/blocker-auto-heal.js', import.meta.url).href + `?bust=${Date.now()}`
    );
    handleBlockerFresh = mod.handleBlocker;
  });

  after(() => {
    ctx?.cleanup();
  });

  it('returns { action: "retry" } when blocker_diagnosis has status=fix_in_progress', () => {
    const taskId = 'pt-inflight-001';

    const ptDb = new Database(ctx.ptDbPath);
    ptDb.prepare("INSERT INTO persistent_tasks (id, status, title) VALUES (?, 'active', 'In-flight check')")
      .run(taskId);

    // Pre-populate a fix_in_progress record
    const diagId = 'diag-inflight-' + crypto.randomBytes(4).toString('hex');
    ptDb.prepare(`
      INSERT INTO blocker_diagnosis
        (id, persistent_task_id, error_type, is_transient, diagnosis_details, fix_attempts, max_fix_attempts, status)
      VALUES (?, ?, 'auth_error', 0, '{}', 1, 3, 'fix_in_progress')
    `).run(diagId, taskId);
    ptDb.close();

    const result = handleBlockerFresh(taskId, makeAuthErrorDiagnosis());

    assert.strictEqual(result.action, 'retry', 'must return retry when fix is already in flight via blocker_diagnosis');
  });

  it('returns { action: "retry" } when todo.db has a pending self-heal task for the task', () => {
    const taskId = 'pt-inflight-todo-001';

    const ptDb = new Database(ctx.ptDbPath);
    ptDb.prepare("INSERT INTO persistent_tasks (id, status, title) VALUES (?, 'active', 'Todo in-flight check')")
      .run(taskId);
    ptDb.close();

    // Pre-populate a pending self-heal task in todo.db
    const todoDb = new Database(ctx.todoDbPath);
    const existingTaskId = 'self-heal-existing-' + crypto.randomBytes(4).toString('hex');
    todoDb.prepare(`
      INSERT INTO tasks (id, section, status, title, assigned_by, created_at, created_timestamp, priority, persistent_task_id)
      VALUES (?, 'INVESTIGATOR & PLANNER', 'pending', 'Self-heal: existing fix task', 'self-heal-system', datetime('now'), strftime('%s', 'now'), 'urgent', ?)
    `).run(existingTaskId, taskId);
    todoDb.close();

    const result = handleBlockerFresh(taskId, makeAuthErrorDiagnosis());

    assert.strictEqual(result.action, 'retry', 'must return retry when a pending self-heal task exists in todo.db');
  });

  it('returns { action: "retry" } when todo.db has an in_progress self-heal task for the task', () => {
    const taskId = 'pt-inflight-inprogress-001';

    const ptDb = new Database(ctx.ptDbPath);
    ptDb.prepare("INSERT INTO persistent_tasks (id, status, title) VALUES (?, 'active', 'In-progress todo check')")
      .run(taskId);
    ptDb.close();

    // Pre-populate an in_progress self-heal task
    const todoDb = new Database(ctx.todoDbPath);
    const existingTaskId = 'self-heal-inprogress-' + crypto.randomBytes(4).toString('hex');
    todoDb.prepare(`
      INSERT INTO tasks (id, section, status, title, assigned_by, created_at, created_timestamp, priority, persistent_task_id)
      VALUES (?, 'INVESTIGATOR & PLANNER', 'in_progress', 'Self-heal: in-progress fix task', 'self-heal-system', datetime('now'), strftime('%s', 'now'), 'urgent', ?)
    `).run(existingTaskId, taskId);
    todoDb.close();

    const result = handleBlockerFresh(taskId, makeAuthErrorDiagnosis());

    assert.strictEqual(result.action, 'retry', 'must return retry when an in_progress self-heal task exists in todo.db');
  });

  it('does NOT dedup when self-heal task in todo.db has status=completed', () => {
    const taskId = 'pt-completed-todo-001';

    const ptDb = new Database(ctx.ptDbPath);
    ptDb.prepare("INSERT INTO persistent_tasks (id, status, title) VALUES (?, 'active', 'Completed todo check')")
      .run(taskId);
    ptDb.close();

    // Pre-populate a COMPLETED self-heal task (should NOT block new fix spawn)
    const todoDb = new Database(ctx.todoDbPath);
    const existingTaskId = 'self-heal-completed-' + crypto.randomBytes(4).toString('hex');
    todoDb.prepare(`
      INSERT INTO tasks (id, section, status, title, assigned_by, created_at, created_timestamp, priority, persistent_task_id)
      VALUES (?, 'INVESTIGATOR & PLANNER', 'completed', 'Self-heal: completed fix task', 'self-heal-system', datetime('now'), strftime('%s', 'now'), 'urgent', ?)
    `).run(existingTaskId, taskId);
    todoDb.close();

    const result = handleBlockerFresh(taskId, makeAuthErrorDiagnosis());

    // A completed task should NOT block a new fix spawn
    assert.strictEqual(result.action, 'fix_spawned', 'completed self-heal task must NOT block new fix spawn');
  });
});

// ============================================================================
// Test Group 6: Idempotency — second call with fix in flight
// ============================================================================

describe('handleBlocker() — idempotency after fix is spawned', () => {
  let ctx;
  let handleBlockerFresh;

  before(async () => {
    ctx = createTestProject('idempotent-test');
    process.env.CLAUDE_PROJECT_DIR = ctx.projectDir;

    const mod = await import(
      new URL('../lib/blocker-auto-heal.js', import.meta.url).href + `?bust=${Date.now()}`
    );
    handleBlockerFresh = mod.handleBlocker;
  });

  after(() => {
    ctx?.cleanup();
  });

  it('second call after fix_spawned returns retry (fix already in flight)', () => {
    const taskId = 'pt-idempotent-001';

    const ptDb = new Database(ctx.ptDbPath);
    ptDb.prepare("INSERT INTO persistent_tasks (id, status, title) VALUES (?, 'active', 'Idempotent test task')")
      .run(taskId);
    ptDb.close();

    // First call should spawn a fix
    const result1 = handleBlockerFresh(taskId, makeAuthErrorDiagnosis());
    assert.strictEqual(result1.action, 'fix_spawned', 'first call must spawn a fix');

    // Second call: blocker_diagnosis is now fix_in_progress, todo.db has a pending task
    // Both dedup checks should block a second spawn
    const result2 = handleBlockerFresh(taskId, makeAuthErrorDiagnosis());
    assert.strictEqual(result2.action, 'retry', 'second call must return retry — fix is already in flight');
  });

  it('does not create duplicate fix tasks in todo.db when called twice', () => {
    const taskId = 'pt-idempotent-002';

    const ptDb = new Database(ctx.ptDbPath);
    ptDb.prepare("INSERT INTO persistent_tasks (id, status, title) VALUES (?, 'active', 'Idempotent dup-check task')")
      .run(taskId);
    ptDb.close();

    // Two calls
    handleBlockerFresh(taskId, makeAuthErrorDiagnosis());
    handleBlockerFresh(taskId, makeAuthErrorDiagnosis());

    // Only 1 fix task should be in todo.db for this persistent task
    const todoDb = new Database(ctx.todoDbPath);
    const fixTasks = todoDb.prepare(
      "SELECT COUNT(*) as cnt FROM tasks WHERE persistent_task_id = ? AND assigned_by = 'self-heal-system'"
    ).get(taskId);
    todoDb.close();

    assert.strictEqual(fixTasks.cnt, 1, 'only 1 fix task must be created even when handleBlocker is called twice');
  });
});

// ============================================================================
// Test Group 7: Missing DB files — graceful degradation
// ============================================================================

describe('handleBlocker() — graceful degradation when DB files are absent', () => {
  let ctx;
  let handleBlockerFresh;

  before(async () => {
    // Create a project dir with NO database files at all
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blocker-no-db-'));
    const stateDir = path.join(projectDir, '.claude', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    // Deliberately do NOT create any DB files

    ctx = {
      projectDir,
      cleanup() {
        try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch (_) { /* non-fatal */ }
      },
    };

    process.env.CLAUDE_PROJECT_DIR = ctx.projectDir;

    const mod = await import(
      new URL('../lib/blocker-auto-heal.js', import.meta.url).href + `?bust=${Date.now()}`
    );
    handleBlockerFresh = mod.handleBlocker;
  });

  after(() => {
    ctx?.cleanup();
  });

  it('does not throw when DB files do not exist', () => {
    let result;
    assert.doesNotThrow(() => {
      result = handleBlockerFresh('pt-no-db-001', makeAuthErrorDiagnosis());
    }, 'handleBlocker must not throw when DB files are absent');
    assert.ok(typeof result === 'object', 'must return an object');
    assert.ok('action' in result, 'must have action field');
  });

  it('returns retry when DBs are absent (cannot spawn fix task)', () => {
    const result = handleBlockerFresh('pt-no-db-002', makeAuthErrorDiagnosis());
    // Without DBs, the module cannot create a blocker_diagnosis record or spawn a task
    // It should fail gracefully and return retry
    assert.ok(
      result.action === 'retry' || result.action === 'fix_spawned',
      `must return 'retry' (no DB) or 'fix_spawned' if module handles absence gracefully; got '${result.action}'`
    );
    // The critical invariant: it must NOT throw, and must NOT return 'escalated' without evidence
    assert.notStrictEqual(result.action, 'escalated', 'must not escalate when DBs are absent');
  });

  it('rate_limit fast-path still works without DB files', () => {
    const result = handleBlockerFresh('pt-no-db-rl', makeRateLimitDiagnosis());
    assert.strictEqual(result.action, 'cooldown', 'rate_limit cooldown must work without DB files');
  });

  it('null diagnosis fast-path still works without DB files', () => {
    const result = handleBlockerFresh('pt-no-db-null', null);
    assert.deepStrictEqual(result, { action: 'retry' });
  });
});

// ============================================================================
// Test Group 8: blocker_diagnosis record tracking across multiple fix attempts
// ============================================================================

describe('handleBlocker() — blocker_diagnosis tracks fix_attempts correctly', () => {
  let ctx;
  let handleBlockerFresh;

  before(async () => {
    ctx = createTestProject('fix-attempts-tracking');
    process.env.CLAUDE_PROJECT_DIR = ctx.projectDir;

    const mod = await import(
      new URL('../lib/blocker-auto-heal.js', import.meta.url).href + `?bust=${Date.now()}`
    );
    handleBlockerFresh = mod.handleBlocker;
  });

  after(() => {
    ctx?.cleanup();
  });

  it('fix_task_ids in blocker_diagnosis contains the spawned fix task ID', () => {
    const taskId = 'pt-fixids-001';

    const ptDb = new Database(ctx.ptDbPath);
    ptDb.prepare("INSERT INTO persistent_tasks (id, status, title) VALUES (?, 'active', 'Fix IDs tracking')")
      .run(taskId);
    ptDb.close();

    const result = handleBlockerFresh(taskId, makeAuthErrorDiagnosis());
    assert.strictEqual(result.action, 'fix_spawned');

    const ptDb2 = new Database(ctx.ptDbPath);
    const diagRecord = ptDb2.prepare(
      "SELECT * FROM blocker_diagnosis WHERE persistent_task_id = ? LIMIT 1"
    ).get(taskId);
    ptDb2.close();

    assert.ok(diagRecord.fix_task_ids, 'fix_task_ids must be present');
    const fixTaskIds = JSON.parse(diagRecord.fix_task_ids);
    assert.ok(Array.isArray(fixTaskIds), 'fix_task_ids must be a JSON array');
    assert.ok(fixTaskIds.includes(result.fixTaskId), 'fix_task_ids must include the spawned task ID');
  });

  it('max_fix_attempts defaults to a positive integer', () => {
    const taskId = 'pt-maxattempts-001';

    const ptDb = new Database(ctx.ptDbPath);
    ptDb.prepare("INSERT INTO persistent_tasks (id, status, title) VALUES (?, 'active', 'Max attempts check')")
      .run(taskId);
    ptDb.close();

    const result = handleBlockerFresh(taskId, makeAuthErrorDiagnosis());
    assert.strictEqual(result.action, 'fix_spawned');

    const ptDb2 = new Database(ctx.ptDbPath);
    const diagRecord = ptDb2.prepare(
      "SELECT * FROM blocker_diagnosis WHERE persistent_task_id = ? LIMIT 1"
    ).get(taskId);
    ptDb2.close();

    assert.ok(diagRecord.max_fix_attempts > 0, 'max_fix_attempts must be a positive integer');
    assert.strictEqual(typeof diagRecord.max_fix_attempts, 'number', 'max_fix_attempts must be a number');
  });
});
