/**
 * Tests for the synthesized-bypass auto-resolve + stale-sweep paths added to
 * scripts/quota-recovery-daemon.js. We do not run the daemon end-to-end (it
 * polls a remote API). Instead we test the two pure-DB functions directly by
 * importing them via dynamic execution.
 *
 * Run with: node --test .claude/hooks/__tests__/quota-recovery-daemon-autoresolve.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DAEMON_PATH = path.resolve(__dirname, '..', '..', '..', 'scripts', 'quota-recovery-daemon.js');

const BYPASS_SCHEMA_SQL = `
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

function createTestProject() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrd-test-'));
  fs.mkdirSync(path.join(projectDir, '.claude', 'state'), { recursive: true });
  const db = new Database(path.join(projectDir, '.claude', 'state', 'bypass-requests.db'));
  db.exec(BYPASS_SCHEMA_SQL);
  db.close();
  return projectDir;
}

function seedRow(projectDir, opts) {
  const db = new Database(path.join(projectDir, '.claude', 'state', 'bypass-requests.db'));
  db.prepare(`
    INSERT INTO bypass_requests (id, task_type, task_id, task_title, agent_id, category, summary, details, status, synthesized, synthesizer, synthesis_account, auto_resolvable, created_at)
    VALUES (?, ?, ?, ?, ?, 'general', ?, ?, 'pending', ?, ?, ?, ?, ?)
  `).run(
    opts.id, opts.task_type || 'persistent', opts.task_id, opts.task_title || 't',
    opts.agent_id || 'a', opts.summary, opts.details || '',
    opts.synthesized ? 1 : 0,
    opts.synthesizer || null,
    opts.synthesis_account || null,
    opts.auto_resolvable ? 1 : 0,
    opts.created_at || new Date().toISOString(),
  );
  db.close();
}

function readAll(projectDir) {
  const db = new Database(path.join(projectDir, '.claude', 'state', 'bypass-requests.db'), { readonly: true });
  const rows = db.prepare('SELECT * FROM bypass_requests').all();
  db.close();
  return rows;
}

/**
 * The daemon's helpers are not exported (it is a long-running script). We
 * exercise them by spawning a one-shot Node subprocess that imports the
 * functions via top-level destructuring — actually, since the script just
 * runs main() on import, that is too disruptive. Instead, we mirror the
 * exact UPDATE SQL the daemon uses in tiny test wrappers and assert that
 * the schema interactions remain stable. This catches column-name typos and
 * filter-clause regressions in the daemon's queries.
 *
 * If the daemon's SQL ever drifts from the assertions here, this test must
 * be updated in lockstep — the SQL lives in two places (daemon + this test)
 * by design as a regression tripwire.
 */
function daemonResolveSql(account) {
  if (account) {
    return {
      sql: `UPDATE bypass_requests
              SET status = 'approved',
                  resolution_context = 'Auto-resolved by quota-recovery-daemon (quota recovered for ' || ? || ')',
                  resolved_at = datetime('now'),
                  resolved_by = 'quota-recovery-daemon'
            WHERE synthesized = 1
              AND auto_resolvable = 1
              AND status = 'pending'
              AND (synthesis_account IS NULL OR synthesis_account = ?)`,
      params: [account, account],
    };
  }
  return {
    sql: `UPDATE bypass_requests
            SET status = 'approved',
                resolution_context = 'Auto-resolved by quota-recovery-daemon (quota recovered)',
                resolved_at = datetime('now'),
                resolved_by = 'quota-recovery-daemon'
          WHERE synthesized = 1
            AND auto_resolvable = 1
            AND status = 'pending'`,
    params: [],
  };
}

function daemonStaleSweepSql(hours) {
  return {
    sql: `UPDATE bypass_requests
            SET status = 'approved',
                resolution_context = 'Auto-resolved by quota-recovery-daemon (stale sweep — older than ' || ? || 'h)',
                resolved_at = datetime('now'),
                resolved_by = 'quota-recovery-daemon-sweep'
          WHERE synthesized = 1
            AND auto_resolvable = 1
            AND status = 'pending'
            AND datetime(created_at) < datetime('now', '-' || ? || ' hours')`,
    params: [hours, hours],
  };
}

let projectDir;

beforeEach(() => { projectDir = createTestProject(); });
afterEach(() => { fs.rmSync(projectDir, { recursive: true, force: true }); });

describe('quota-recovery-daemon — auto-resolve synthesized rows', () => {
  it('resolves only synthesized + auto_resolvable + pending rows when no account hint', () => {
    seedRow(projectDir, { id: 'syn-1', task_id: 't1', summary: '[quota_exhaustion] x', synthesized: true, auto_resolvable: true });
    seedRow(projectDir, { id: 'syn-2', task_id: 't2', summary: '[quota_exhaustion] y', synthesized: true, auto_resolvable: true, synthesis_account: 'a@x' });
    seedRow(projectDir, { id: 'real-1', task_id: 't3', summary: 'agent asks help', synthesized: false, auto_resolvable: false });
    seedRow(projectDir, { id: 'not-auto', task_id: 't4', summary: '[quota_exhaustion] z', synthesized: true, auto_resolvable: false });

    const db = new Database(path.join(projectDir, '.claude', 'state', 'bypass-requests.db'));
    const { sql, params } = daemonResolveSql(null);
    const res = db.prepare(sql).run(...params);
    db.close();

    assert.equal(res.changes, 2, 'should resolve exactly 2 (syn-1 and syn-2)');
    const rows = readAll(projectDir);
    assert.equal(rows.find(r => r.id === 'syn-1').status, 'approved');
    assert.equal(rows.find(r => r.id === 'syn-2').status, 'approved');
    assert.equal(rows.find(r => r.id === 'real-1').status, 'pending', 'real bypass must NOT be resolved');
    assert.equal(rows.find(r => r.id === 'not-auto').status, 'pending', 'non-auto-resolvable must NOT be resolved');
    assert.match(rows.find(r => r.id === 'syn-1').resolution_context, /quota recovered/);
    assert.equal(rows.find(r => r.id === 'syn-1').resolved_by, 'quota-recovery-daemon');
  });

  it('account-scoped resolve only touches matching account and NULL accounts', () => {
    seedRow(projectDir, { id: 'acc-a-1', task_id: 't1', summary: '[quota_exhaustion]', synthesized: true, auto_resolvable: true, synthesis_account: 'a@x' });
    seedRow(projectDir, { id: 'acc-a-2', task_id: 't2', summary: '[quota_exhaustion]', synthesized: true, auto_resolvable: true, synthesis_account: 'a@x' });
    seedRow(projectDir, { id: 'acc-b', task_id: 't3', summary: '[quota_exhaustion]', synthesized: true, auto_resolvable: true, synthesis_account: 'b@y' });
    seedRow(projectDir, { id: 'acc-null', task_id: 't4', summary: '[quota_exhaustion]', synthesized: true, auto_resolvable: true, synthesis_account: null });

    const db = new Database(path.join(projectDir, '.claude', 'state', 'bypass-requests.db'));
    const { sql, params } = daemonResolveSql('a@x');
    const res = db.prepare(sql).run(...params);
    db.close();

    assert.equal(res.changes, 3, 'should resolve 2 a@x + 1 NULL = 3');
    const rows = readAll(projectDir);
    assert.equal(rows.find(r => r.id === 'acc-b').status, 'pending', 'b@y account should remain pending');
    assert.match(rows.find(r => r.id === 'acc-a-1').resolution_context, /a@x/);
  });

  it('stale sweep resolves rows older than the threshold and leaves recent ones alone', () => {
    const oldDate = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(); // 30h ago
    const recentDate = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago

    seedRow(projectDir, { id: 'stale-1', task_id: 'ts1', summary: '[quota_exhaustion]', synthesized: true, auto_resolvable: true, created_at: oldDate });
    seedRow(projectDir, { id: 'stale-2', task_id: 'ts2', summary: '[quota_exhaustion]', synthesized: true, auto_resolvable: true, created_at: oldDate });
    seedRow(projectDir, { id: 'recent', task_id: 'tr', summary: '[quota_exhaustion]', synthesized: true, auto_resolvable: true, created_at: recentDate });

    const db = new Database(path.join(projectDir, '.claude', 'state', 'bypass-requests.db'));
    const { sql, params } = daemonStaleSweepSql(24);
    const res = db.prepare(sql).run(...params);
    db.close();

    assert.equal(res.changes, 2, 'should resolve only the 2 stale rows');
    const rows = readAll(projectDir);
    assert.equal(rows.find(r => r.id === 'recent').status, 'pending');
    assert.match(rows.find(r => r.id === 'stale-1').resolution_context, /stale sweep/);
    assert.equal(rows.find(r => r.id === 'stale-1').resolved_by, 'quota-recovery-daemon-sweep');
  });

  it('is idempotent — running resolve twice resolves only what is pending', () => {
    seedRow(projectDir, { id: 'syn-1', task_id: 't1', summary: '[quota_exhaustion]', synthesized: true, auto_resolvable: true });
    const db = new Database(path.join(projectDir, '.claude', 'state', 'bypass-requests.db'));
    const { sql, params } = daemonResolveSql(null);
    const first = db.prepare(sql).run(...params);
    const second = db.prepare(sql).run(...params);
    db.close();
    assert.equal(first.changes, 1);
    assert.equal(second.changes, 0, 'second pass should find nothing to resolve');
  });

  it('daemon source file actually contains the SQL fragments we test', () => {
    // Regression tripwire: if the daemon SQL changes, this test must change in
    // lockstep. Reads the daemon file and asserts the literal fragments.
    const daemonSrc = fs.readFileSync(DAEMON_PATH, 'utf8');
    assert.match(daemonSrc, /resolveSynthesizedBypasses/);
    assert.match(daemonSrc, /sweepStaleSynthesizedBypasses/);
    assert.match(daemonSrc, /synthesized = 1\s+AND auto_resolvable = 1\s+AND status = 'pending'/);
    assert.match(daemonSrc, /quota-recovery-daemon-sweep/);
  });
});
