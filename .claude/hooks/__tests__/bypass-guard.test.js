/**
 * Tests for lib/bypass-guard.js
 *
 * Validates:
 * 1. checkBypassBlock() — returns blocked when a pending request exists
 * 2. checkBypassBlock() — returns unblocked when no DB exists
 * 3. checkBypassBlock() — returns unblocked when request is resolved (approved/rejected)
 * 4. checkBypassBlock() — handles missing arguments gracefully (fail-open)
 * 5. getBypassResolutionContext() — returns resolved request context
 * 6. getBypassResolutionContext() — returns null when no resolved request exists
 * 7. getBypassResolutionContext() — returns most-recent resolved request (ORDER BY resolved_at DESC)
 * 8. Both functions — fail-open on corrupt / missing DB
 *
 * Strategy: create a real SQLite database in /tmp with the bypass_requests schema
 * (mirrored from packages/mcp-servers/src/agent-tracker/server.ts), point
 * CLAUDE_PROJECT_DIR at the temp dir, and import bypass-guard.js via dynamic
 * import with a cache-bust query string so each test group gets a fresh module.
 *
 * The module-level Database import and BYPASS_DB_PATH constant are computed at
 * load time, so we must set CLAUDE_PROJECT_DIR before the first import.
 *
 * Run with: node --test .claude/hooks/__tests__/bypass-guard.test.js
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

// ============================================================================
// Schema — mirrored verbatim from server.ts openBypassDb()
// ============================================================================

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
  CREATE INDEX IF NOT EXISTS idx_bypass_status ON bypass_requests(status);
  CREATE INDEX IF NOT EXISTS idx_bypass_task ON bypass_requests(task_type, task_id);
`;

// ============================================================================
// Helpers
// ============================================================================

function generateId() {
  return `bypass-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Create a temp project directory with the .claude/state/ path and a
 * bypass-requests.db initialized with the production schema.
 * Returns { projectDir, dbPath, db, cleanup }.
 */
function createTestProject(prefix = 'bypass-guard-test') {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
  const stateDir = path.join(projectDir, '.claude', 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  const dbPath = path.join(stateDir, 'bypass-requests.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 3000');
  db.exec(BYPASS_SCHEMA_SQL);

  return {
    projectDir,
    dbPath,
    db,
    cleanup() {
      try { db.close(); } catch (_) { /* non-fatal */ }
      try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch (_) { /* non-fatal */ }
    },
  };
}

/**
 * Insert a bypass_requests row with sensible defaults.
 */
function insertRequest(db, {
  id = generateId(),
  taskType = 'persistent',
  taskId = 'task-123',
  taskTitle = 'Test Task',
  category = 'general',
  summary = 'Test summary',
  status = 'pending',
  resolutionContext = null,
  resolvedAt = null,
} = {}) {
  db.prepare(`
    INSERT INTO bypass_requests
      (id, task_type, task_id, task_title, category, summary, status, resolution_context, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, taskType, taskId, taskTitle, category, summary, status, resolutionContext, resolvedAt);
  return id;
}

// ============================================================================
// Module import with env-var injection
// ============================================================================

let checkBypassBlock;
let getBypassResolutionContext;
let testProject;

before(async () => {
  // Create a project dir with a real DB so the module imports cleanly.
  testProject = createTestProject('bypass-guard-main');
  process.env.CLAUDE_PROJECT_DIR = testProject.projectDir;

  // Cache-bust so we get a fresh module that reads CLAUDE_PROJECT_DIR now.
  const mod = await import(
    new URL('../lib/bypass-guard.js', import.meta.url).href + `?bust=${Date.now()}`
  );
  checkBypassBlock = mod.checkBypassBlock;
  getBypassResolutionContext = mod.getBypassResolutionContext;
});

after(() => {
  testProject?.cleanup();
});

// Clean the DB rows between tests so each test starts from a known state.
beforeEach(() => {
  testProject.db.exec("DELETE FROM bypass_requests");
});

// ============================================================================
// checkBypassBlock — core blocking behaviour
// ============================================================================

describe('checkBypassBlock()', () => {

  it('returns { blocked: false } when no rows exist for task', () => {
    const result = checkBypassBlock('persistent', 'task-absent');
    assert.strictEqual(result.blocked, false);
  });

  it('returns blocked=true with request metadata when pending request exists', () => {
    const id = insertRequest(testProject.db, {
      taskType: 'persistent',
      taskId: 'task-abc',
      summary: 'Need CTO approval to proceed',
      category: 'scope_change',
      status: 'pending',
    });

    const result = checkBypassBlock('persistent', 'task-abc');
    assert.strictEqual(result.blocked, true);
    assert.strictEqual(result.requestId, id);
    assert.strictEqual(result.summary, 'Need CTO approval to proceed');
    assert.strictEqual(result.category, 'scope_change');
  });

  it('returns blocked=false when request is approved (not pending)', () => {
    insertRequest(testProject.db, {
      taskType: 'persistent',
      taskId: 'task-approved',
      status: 'approved',
      resolutionContext: 'Go ahead',
      resolvedAt: "datetime('now')",
    });

    const result = checkBypassBlock('persistent', 'task-approved');
    assert.strictEqual(result.blocked, false);
  });

  it('returns blocked=false when request is rejected (not pending)', () => {
    insertRequest(testProject.db, {
      taskType: 'persistent',
      taskId: 'task-rejected',
      status: 'rejected',
      resolutionContext: 'Not approved',
    });

    const result = checkBypassBlock('persistent', 'task-rejected');
    assert.strictEqual(result.blocked, false);
  });

  it('returns blocked=false when request is cancelled (not pending)', () => {
    insertRequest(testProject.db, {
      taskType: 'persistent',
      taskId: 'task-cancelled',
      status: 'cancelled',
    });

    const result = checkBypassBlock('persistent', 'task-cancelled');
    assert.strictEqual(result.blocked, false);
  });

  it('distinguishes task_type — pending todo request does not block persistent task', () => {
    insertRequest(testProject.db, {
      taskType: 'todo',
      taskId: 'shared-id',
      status: 'pending',
    });

    // Same task_id but different task_type should NOT be blocked
    const result = checkBypassBlock('persistent', 'shared-id');
    assert.strictEqual(result.blocked, false);
  });

  it('distinguishes task_type — pending persistent request does not block todo task', () => {
    insertRequest(testProject.db, {
      taskType: 'persistent',
      taskId: 'shared-id-2',
      status: 'pending',
    });

    const result = checkBypassBlock('todo', 'shared-id-2');
    assert.strictEqual(result.blocked, false);
  });

  it('returns blocked=true for todo task_type when pending request exists', () => {
    const id = insertRequest(testProject.db, {
      taskType: 'todo',
      taskId: 'todo-task-1',
      summary: 'Todo task needs approval',
      category: 'destructive_operation',
      status: 'pending',
    });

    const result = checkBypassBlock('todo', 'todo-task-1');
    assert.strictEqual(result.blocked, true);
    assert.strictEqual(result.requestId, id);
    assert.strictEqual(result.category, 'destructive_operation');
  });

  it('only returns the first pending request (LIMIT 1) when multiple exist', () => {
    // Insert two pending requests for the same task — only first matters
    const id1 = insertRequest(testProject.db, {
      taskType: 'persistent',
      taskId: 'task-multi',
      summary: 'First request',
      status: 'pending',
    });
    insertRequest(testProject.db, {
      taskType: 'persistent',
      taskId: 'task-multi',
      summary: 'Second request',
      status: 'pending',
    });

    const result = checkBypassBlock('persistent', 'task-multi');
    assert.strictEqual(result.blocked, true);
    // Must return exactly one result, not throw or accumulate both
    assert.ok(typeof result.requestId === 'string');
    assert.ok(typeof result.summary === 'string');
  });

  // ---- Fail-open / guard-rail behaviour ----

  it('returns { blocked: false } when taskType is falsy', () => {
    insertRequest(testProject.db, { taskType: 'persistent', taskId: 'task-xyz', status: 'pending' });
    assert.deepStrictEqual(checkBypassBlock(null, 'task-xyz'), { blocked: false });
    assert.deepStrictEqual(checkBypassBlock('', 'task-xyz'), { blocked: false });
    assert.deepStrictEqual(checkBypassBlock(undefined, 'task-xyz'), { blocked: false });
  });

  it('returns { blocked: false } when taskId is falsy', () => {
    assert.deepStrictEqual(checkBypassBlock('persistent', null), { blocked: false });
    assert.deepStrictEqual(checkBypassBlock('persistent', ''), { blocked: false });
    assert.deepStrictEqual(checkBypassBlock('persistent', undefined), { blocked: false });
  });

  it('returns { blocked: false } when DB file does not exist', () => {
    // Point to a project dir with NO bypass-requests.db
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bypass-guard-empty-'));
    fs.mkdirSync(path.join(emptyDir, '.claude', 'state'), { recursive: true });

    // We can't re-import the module with a different env, but we can verify
    // the exported function handles the case when the path computed at import
    // time does not exist.
    // The module was imported with testProject.projectDir set; we delete the
    // DB to simulate the "no DB file" path.
    const dbPath = path.join(testProject.projectDir, '.claude', 'state', 'bypass-requests.db');
    testProject.db.close();
    fs.renameSync(dbPath, dbPath + '.bak');

    try {
      const result = checkBypassBlock('persistent', 'any-task');
      assert.strictEqual(result.blocked, false, 'Must fail-open when DB file is absent');
    } finally {
      // Restore so other tests can continue using the db
      fs.renameSync(dbPath + '.bak', dbPath);
      // Re-open the db handle for subsequent beforeEach() deletes
      const restored = new Database(dbPath);
      restored.pragma('busy_timeout = 3000');
      testProject.db = restored;
    }

    fs.rmSync(emptyDir, { recursive: true, force: true });
  });
});

// ============================================================================
// getBypassResolutionContext() — resolved request context
// ============================================================================

describe('getBypassResolutionContext()', () => {

  it('returns null when no rows exist for task', () => {
    const result = getBypassResolutionContext('persistent', 'task-absent');
    assert.strictEqual(result, null);
  });

  it('returns null when only a pending request exists (not resolved)', () => {
    insertRequest(testProject.db, {
      taskType: 'persistent',
      taskId: 'task-pending-only',
      status: 'pending',
    });

    const result = getBypassResolutionContext('persistent', 'task-pending-only');
    assert.strictEqual(result, null);
  });

  it('returns context for an approved request', () => {
    const id = insertRequest(testProject.db, {
      taskType: 'persistent',
      taskId: 'task-app',
      summary: 'Needs approval',
      category: 'resource_access',
      status: 'approved',
      resolutionContext: 'Approved: proceed with caution',
      resolvedAt: "2026-04-14T10:00:00",
    });

    const result = getBypassResolutionContext('persistent', 'task-app');
    assert.notStrictEqual(result, null);
    assert.strictEqual(result.decision, 'approved');
    assert.strictEqual(result.requestId, id);
    assert.strictEqual(result.summary, 'Needs approval');
    assert.strictEqual(result.category, 'resource_access');
    assert.strictEqual(result.context, 'Approved: proceed with caution');
  });

  it('returns context for a rejected request', () => {
    const id = insertRequest(testProject.db, {
      taskType: 'persistent',
      taskId: 'task-rej',
      summary: 'Rejected task',
      category: 'destructive_operation',
      status: 'rejected',
      resolutionContext: 'Too risky',
      resolvedAt: "2026-04-14T09:00:00",
    });

    const result = getBypassResolutionContext('persistent', 'task-rej');
    assert.notStrictEqual(result, null);
    assert.strictEqual(result.decision, 'rejected');
    assert.strictEqual(result.requestId, id);
    assert.strictEqual(result.context, 'Too risky');
  });

  it('returns empty string for context when resolution_context is NULL', () => {
    insertRequest(testProject.db, {
      taskType: 'persistent',
      taskId: 'task-no-ctx',
      status: 'approved',
      resolutionContext: null,
      resolvedAt: "2026-04-14T08:00:00",
    });

    const result = getBypassResolutionContext('persistent', 'task-no-ctx');
    assert.notStrictEqual(result, null);
    assert.strictEqual(result.context, '', 'context must be empty string when resolution_context is NULL');
  });

  it('returns the MOST RECENT resolved request when multiple exist', () => {
    // Insert an older approved then a newer rejected — most recent wins
    insertRequest(testProject.db, {
      id: 'bypass-older',
      taskType: 'persistent',
      taskId: 'task-order',
      summary: 'Older approval',
      status: 'approved',
      resolutionContext: 'Old decision',
      resolvedAt: "2026-04-13T08:00:00",
    });
    insertRequest(testProject.db, {
      id: 'bypass-newer',
      taskType: 'persistent',
      taskId: 'task-order',
      summary: 'Newer rejection',
      status: 'rejected',
      resolutionContext: 'Changed my mind',
      resolvedAt: "2026-04-14T12:00:00",
    });

    const result = getBypassResolutionContext('persistent', 'task-order');
    assert.notStrictEqual(result, null);
    assert.strictEqual(result.requestId, 'bypass-newer', 'Must return the most-recent resolved request');
    assert.strictEqual(result.decision, 'rejected');
    assert.strictEqual(result.context, 'Changed my mind');
  });

  it('does not return cancelled requests (only approved/rejected)', () => {
    insertRequest(testProject.db, {
      taskType: 'persistent',
      taskId: 'task-cancelled-ctx',
      status: 'cancelled',
      resolutionContext: 'Auto-cancelled',
      resolvedAt: "2026-04-14T07:00:00",
    });

    const result = getBypassResolutionContext('persistent', 'task-cancelled-ctx');
    assert.strictEqual(result, null, 'cancelled requests must not be returned as resolution context');
  });

  it('distinguishes task_type — approved todo request does not surface for persistent task', () => {
    insertRequest(testProject.db, {
      taskType: 'todo',
      taskId: 'shared-ctx-id',
      status: 'approved',
      resolutionContext: 'Only for todo',
      resolvedAt: "2026-04-14T10:00:00",
    });

    const result = getBypassResolutionContext('persistent', 'shared-ctx-id');
    assert.strictEqual(result, null);
  });

  // ---- Fail-open / guard-rail behaviour ----

  it('returns null when taskType is falsy', () => {
    insertRequest(testProject.db, {
      taskType: 'persistent',
      taskId: 'task-guard',
      status: 'approved',
      resolutionContext: 'ok',
      resolvedAt: "2026-04-14T10:00:00",
    });
    assert.strictEqual(getBypassResolutionContext(null, 'task-guard'), null);
    assert.strictEqual(getBypassResolutionContext('', 'task-guard'), null);
  });

  it('returns null when taskId is falsy', () => {
    assert.strictEqual(getBypassResolutionContext('persistent', null), null);
    assert.strictEqual(getBypassResolutionContext('persistent', ''), null);
  });
});
