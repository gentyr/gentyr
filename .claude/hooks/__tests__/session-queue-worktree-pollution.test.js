/**
 * Tests for the worktree-pollution defenses in `lib/session-queue.js`.
 *
 * Two layers:
 *   - Layer 2A: `spawnQueueItem` REFUSES to fall back to PROJECT_DIR when a
 *     queue row's `worktree_path` was set but the directory is missing.
 *     Source-code structural check (the full spawn path is hard to exercise
 *     in isolation).
 *   - Layer 2B: Step 1d revival enqueue CARRIES FORWARD the prior queue
 *     row's `worktree_path` when the directory still exists on disk.
 *     SQL behavioral check using the production schema.
 *
 * Run with: node --test .claude/hooks/__tests__/session-queue-worktree-pollution.test.js
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

// ============================================================================
// Layer 2A — structural checks
// ============================================================================

describe('Layer 2A — spawnQueueItem refuses fallback when worktree_path set but missing', () => {
  it('refuse-on-missing branch exists in source', () => {
    assert.match(sourceCode, /worktree_missing_at_spawn/);
    assert.match(sourceCode, /REFUSING to spawn/);
  });

  it("marks queue row 'failed' instead of falling back", () => {
    assert.match(
      sourceCode,
      /UPDATE queue_items SET status = 'failed', error = \?, completed_at = datetime\('now'\)/,
    );
  });

  it('emits session_failed audit event with reason=worktree_missing_at_spawn', () => {
    assert.match(sourceCode, /auditEvent\('session_failed'/);
    assert.match(sourceCode, /reason: 'worktree_missing_at_spawn'/);
  });

  it('resets linked todo task to pending on refusal', () => {
    // The refusal block must include the same reset-to-pending SQL used elsewhere
    const block = extractRefusalBlock(sourceCode);
    assert.match(block, /UPDATE tasks SET status = 'pending'/);
    assert.match(block, /status = 'in_progress'/);
  });

  it('refuses ONLY when worktree_path was set (not for legitimate project_dir spawns)', () => {
    // The condition must check item.worktree_path (the set-but-missing case),
    // not just any missing CWD. Look in the full source rather than slicing.
    assert.match(sourceCode, /item\.worktree_path && !fs\.existsSync\(item\.worktree_path\)/);
  });

  it('preserves the existing soft-fallback for cases where worktree_path was never set', () => {
    // The original "fall back to project dir" branch must still exist
    // (covers legitimate spawns into PROJECT_DIR for system maintenance).
    assert.match(sourceCode, /falling back to project dir/);
  });
});

function extractRefusalBlock(src) {
  const start = src.indexOf('REFUSING to spawn');
  assert.ok(start >= 0, 'refusal block not found in source');
  // Extract a reasonable window
  return src.slice(start, start + 2500);
}

// ============================================================================
// Layer 2B — SQL behavioral check
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
`;

/**
 * The exact query used by Step 1d's worktree carry-forward — checks for
 * the most recent prior queue row for a taskId that has worktree_path set.
 */
const CARRY_FORWARD_QUERY = "SELECT worktree_path, cwd FROM queue_items "
  + "WHERE json_extract(metadata, '$.taskId') = ? AND worktree_path IS NOT NULL "
  + "ORDER BY enqueued_at DESC LIMIT 1";

function createQueueDb() {
  const dbPath = path.join(os.tmpdir(), `wt-pollution-test-${Date.now()}-${crypto.randomBytes(2).toString('hex')}.db`);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(QUEUE_SCHEMA_SQL);
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

function insertPriorQueueItem(db, { id, taskId, worktreePath, cwd, enqueuedAt = null }) {
  const enqVal = enqueuedAt || "datetime('now')";
  db.prepare(`
    INSERT INTO queue_items
      (id, status, priority, lane, spawn_type, title, agent_type, hook_type, tag_context,
       project_dir, worktree_path, cwd, metadata, source, enqueued_at)
    VALUES
      (?, 'completed', 'normal', 'standard', 'fresh', 'prior', 'task-runner', 'task-runner', 'tag',
       '/tmp/proj', ?, ?, ?, 'test', ${enqueuedAt ? '?' : enqVal})
  `).run(...[
    id, worktreePath, cwd, JSON.stringify({ taskId }),
    ...(enqueuedAt ? [enqueuedAt] : []),
  ]);
}

describe('Layer 2B — Step 1d worktree carry-forward query', () => {
  it('returns the most recent prior row with worktree_path set', () => {
    const { db, cleanup } = createQueueDb();
    try {
      const tmpWt = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));
      try {
        insertPriorQueueItem(db, { id: 'q1', taskId: 't1', worktreePath: tmpWt, cwd: tmpWt });
        const row = db.prepare(CARRY_FORWARD_QUERY).get('t1');
        assert.equal(row.worktree_path, tmpWt);
        assert.equal(row.cwd, tmpWt);
      } finally {
        try { fs.rmSync(tmpWt, { recursive: true, force: true }); } catch { /* non-fatal */ }
      }
    } finally {
      cleanup();
    }
  });

  it('returns nothing when no prior row has worktree_path set', () => {
    const { db, cleanup } = createQueueDb();
    try {
      insertPriorQueueItem(db, { id: 'q1', taskId: 't1', worktreePath: null, cwd: null });
      const row = db.prepare(CARRY_FORWARD_QUERY).get('t1');
      assert.equal(row, undefined);
    } finally {
      cleanup();
    }
  });

  it('picks the most recent row when multiple priors have worktree_path', () => {
    const { db, cleanup } = createQueueDb();
    try {
      // Force a deterministic ordering by setting enqueued_at explicitly
      insertPriorQueueItem(db, { id: 'q-old', taskId: 't1', worktreePath: '/wt/old', cwd: '/wt/old', enqueuedAt: '2026-01-01 00:00:00' });
      insertPriorQueueItem(db, { id: 'q-new', taskId: 't1', worktreePath: '/wt/new', cwd: '/wt/new', enqueuedAt: '2026-05-27 00:00:00' });
      const row = db.prepare(CARRY_FORWARD_QUERY).get('t1');
      assert.equal(row.worktree_path, '/wt/new');
    } finally {
      cleanup();
    }
  });

  it('scopes to taskId — other tasks do not leak through', () => {
    const { db, cleanup } = createQueueDb();
    try {
      insertPriorQueueItem(db, { id: 'q1', taskId: 't1', worktreePath: '/wt/t1', cwd: '/wt/t1' });
      const row = db.prepare(CARRY_FORWARD_QUERY).get('t2');
      assert.equal(row, undefined);
    } finally {
      cleanup();
    }
  });
});

describe('Layer 2B — structural checks on source', () => {
  it('Step 1d INSERT now includes worktree_path and cwd columns', () => {
    // The carriedWorktreePath variable is unique to the Step 1d carry-forward path.
    assert.match(sourceCode, /carriedWorktreePath/);
    // Locate the carry-forward block and verify the INSERT body that follows
    // it includes both worktree_path and cwd column names.
    const start = sourceCode.indexOf('carriedWorktreePath');
    assert.ok(start >= 0);
    const window = sourceCode.slice(start, start + 3000);
    assert.match(window, /INSERT INTO queue_items[\s\S]+?cwd[\s\S]+?worktree_path/);
  });

  it("Step 1d only carries forward when the prior worktree exists on disk (fs.existsSync gate)", () => {
    const start = sourceCode.indexOf('carriedWorktreePath');
    assert.ok(start >= 0);
    const block = sourceCode.slice(start, start + 1500);
    assert.match(block, /fs\.existsSync\(priorRow\.worktree_path\)/);
  });

  it('Step 1d revival metadata records whether worktree was carried forward', () => {
    assert.match(sourceCode, /worktreeCarriedForward/);
  });
});
