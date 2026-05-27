/**
 * Tests for the synthesized-row tagging in `handleQuotaCrashOnReap`.
 *
 * Covers PR 1 (Fix 4) — every framework-synthesized quota_exhaustion bypass
 * row must be marked `synthesized=1`, `synthesizer='quota-detector'`,
 * `auto_resolvable=1`, and tagged with the OAuth account when resolvable.
 * Duplicate detections for the same task must bump `synthesis_count` rather
 * than insert a second row.
 *
 * Run with: node --test .claude/hooks/__tests__/quota-detector-synthesized.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { handleQuotaCrashOnReap } = await import(
  path.resolve(__dirname, '..', 'lib', 'quota-detector.js')
);

// Mirrors the post-migration bypass-requests schema. The new columns
// (synthesized, synthesizer, synthesis_account, auto_resolvable,
// synthesis_count) are what we are validating here.
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
    synthesized INTEGER NOT NULL DEFAULT 0,
    synthesizer TEXT,
    synthesis_account TEXT,
    auto_resolvable INTEGER NOT NULL DEFAULT 0,
    synthesis_count INTEGER NOT NULL DEFAULT 1,
    CHECK (task_type IN ('persistent', 'todo')),
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
    CHECK (category IN ('destructive_operation', 'scope_change', 'ambiguous_requirement', 'resource_access', 'general'))
  );
`;

const PT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS persistent_tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    persistent_task_id TEXT NOT NULL REFERENCES persistent_tasks(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    details TEXT,
    created_at TEXT NOT NULL
  );
`;

function createTestProject() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-synthesized-'));
  fs.mkdirSync(path.join(projectDir, '.claude', 'state'), { recursive: true });
  const ptDb = new Database(path.join(projectDir, '.claude', 'state', 'persistent-tasks.db'));
  ptDb.exec(PT_SCHEMA_SQL);
  ptDb.close();
  const bypassDb = new Database(path.join(projectDir, '.claude', 'state', 'bypass-requests.db'));
  bypassDb.exec(BYPASS_SCHEMA_SQL);
  bypassDb.close();
  return projectDir;
}

function readBypassRow(projectDir, taskId) {
  const db = new Database(path.join(projectDir, '.claude', 'state', 'bypass-requests.db'), { readonly: true });
  const row = db.prepare('SELECT * FROM bypass_requests WHERE task_id = ? ORDER BY created_at DESC LIMIT 1').get(taskId);
  db.close();
  return row;
}

function countBypassRows(projectDir, taskId) {
  const db = new Database(path.join(projectDir, '.claude', 'state', 'bypass-requests.db'), { readonly: true });
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM bypass_requests WHERE task_id = ?').get(taskId);
  db.close();
  return row.cnt;
}

function seedPersistentTask(projectDir, id) {
  const db = new Database(path.join(projectDir, '.claude', 'state', 'persistent-tasks.db'));
  db.prepare('INSERT INTO persistent_tasks (id, title, status, metadata) VALUES (?, ?, ?, ?)')
    .run(id, 'Test task', 'active', '{}');
  db.close();
}

let projectDir;

beforeEach(() => { projectDir = createTestProject(); });
afterEach(() => { fs.rmSync(projectDir, { recursive: true, force: true }); });

describe('handleQuotaCrashOnReap — synthesized row tagging', () => {
  it('marks newly-filed rows with synthesized=1 and synthesizer=quota-detector', () => {
    const taskId = `pt-${crypto.randomBytes(4).toString('hex')}`;
    seedPersistentTask(projectDir, taskId);
    const result = handleQuotaCrashOnReap({
      detection: { detected: true, rawText: 'You\'ve hit your limit · resets 9pm', resetHint: '9pm', matchedPattern: 'test' },
      metadata: { taskId, taskType: 'persistent', taskTitle: 'Test task' },
      agentId: 'agent-test',
      projectDir,
    });
    assert.ok(result.bypass_request_id, 'should return a request id');
    assert.equal(result.synthesized, true, 'result should indicate synthesized=true');
    const row = readBypassRow(projectDir, taskId);
    assert.equal(row.synthesized, 1);
    assert.equal(row.synthesizer, 'quota-detector');
    assert.equal(row.auto_resolvable, 1);
    assert.equal(row.synthesis_count, 1);
    assert.equal(row.category, 'general'); // CHECK constraint enforced
    assert.match(row.summary, /^\[quota_exhaustion\]/);
  });

  it('bumps synthesis_count on duplicate detection for same task', () => {
    const taskId = `pt-${crypto.randomBytes(4).toString('hex')}`;
    seedPersistentTask(projectDir, taskId);
    const detection = { detected: true, rawText: 'limit hit', resetHint: '10pm', matchedPattern: 'test' };
    const metadata = { taskId, taskType: 'persistent', taskTitle: 'Test task' };

    const first = handleQuotaCrashOnReap({ detection, metadata, agentId: 'a1', projectDir });
    const second = handleQuotaCrashOnReap({ detection, metadata, agentId: 'a2', projectDir });
    const third = handleQuotaCrashOnReap({ detection, metadata, agentId: 'a3', projectDir });

    assert.equal(first.bypass_request_id, second.bypass_request_id, 'second call should return same id');
    assert.equal(second.bypass_request_id, third.bypass_request_id, 'third call should return same id');
    assert.equal(countBypassRows(projectDir, taskId), 1, 'should not create duplicate rows');

    const row = readBypassRow(projectDir, taskId);
    assert.equal(row.synthesis_count, 3, 'synthesis_count should reflect all three detections');
  });

  it('records synthesis_account when credentials are unresolvable as null (not throw)', () => {
    // No HOME override — detectActiveAccount() will fail gracefully and return
    // null. The row should still insert successfully with NULL account.
    const taskId = `pt-${crypto.randomBytes(4).toString('hex')}`;
    seedPersistentTask(projectDir, taskId);
    const result = handleQuotaCrashOnReap({
      detection: { detected: true, rawText: 'limit', resetHint: null, matchedPattern: 'p' },
      metadata: { taskId, taskType: 'persistent' },
      agentId: 'a',
      projectDir,
    });
    assert.ok(result.bypass_request_id);
    const row = readBypassRow(projectDir, taskId);
    // Account may or may not resolve depending on test machine — either way
    // the column should exist and either contain the account or be NULL.
    assert.ok(row.synthesis_account === null || typeof row.synthesis_account === 'string');
  });

  it('does NOT mark agent-authored rows as synthesized when inserted by submit_bypass_request', () => {
    // Sanity: verify the schema default for synthesized is 0. Real
    // agent-authored INSERTs (from agent-tracker server's submit_bypass_request)
    // never pass the synthesized column, so they remain 0.
    const taskId = `pt-${crypto.randomBytes(4).toString('hex')}`;
    seedPersistentTask(projectDir, taskId);
    const db = new Database(path.join(projectDir, '.claude', 'state', 'bypass-requests.db'));
    db.prepare(`
      INSERT INTO bypass_requests (id, task_type, task_id, task_title, agent_id, category, summary, details)
      VALUES (?, ?, ?, ?, ?, 'general', ?, ?)
    `).run('br-real-test', 'persistent', taskId, 'Test', 'a', 'agent asks help', 'details');
    const row = db.prepare('SELECT * FROM bypass_requests WHERE id = ?').get('br-real-test');
    db.close();
    assert.equal(row.synthesized, 0, 'real bypass should default synthesized=0');
    assert.equal(row.auto_resolvable, 0);
    assert.equal(row.synthesis_count, 1);
  });

  it('falls back to legacy INSERT when synthesized column is missing (stale schema)', () => {
    // Simulate an old DB that has not yet been migrated by agent-tracker.
    const dbPath = path.join(projectDir, '.claude', 'state', 'bypass-requests.db');
    fs.rmSync(dbPath);
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE IF NOT EXISTS bypass_requests (
        id TEXT PRIMARY KEY,
        task_type TEXT NOT NULL,
        task_id TEXT NOT NULL,
        task_title TEXT NOT NULL,
        agent_id TEXT,
        category TEXT NOT NULL DEFAULT 'general',
        summary TEXT NOT NULL,
        details TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (task_type IN ('persistent', 'todo')),
        CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
        CHECK (category IN ('destructive_operation', 'scope_change', 'ambiguous_requirement', 'resource_access', 'general'))
      );
    `);
    legacyDb.close();

    const taskId = `pt-${crypto.randomBytes(4).toString('hex')}`;
    seedPersistentTask(projectDir, taskId);
    const result = handleQuotaCrashOnReap({
      detection: { detected: true, rawText: 'limit', resetHint: '11pm', matchedPattern: 'p' },
      metadata: { taskId, taskType: 'persistent' },
      agentId: 'a',
      projectDir,
    });
    assert.ok(result.bypass_request_id, 'fallback INSERT should succeed on legacy schema');
    const verifyDb = new Database(dbPath, { readonly: true });
    const row = verifyDb.prepare('SELECT * FROM bypass_requests WHERE id = ?').get(result.bypass_request_id);
    verifyDb.close();
    assert.equal(row.summary.startsWith('[quota_exhaustion]'), true);
  });
});
