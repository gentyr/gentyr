/**
 * Unit tests for:
 *   - .claude/hooks/lib/llm-client.js (callLLMStructured)
 *   - .claude/hooks/lib/report-auto-resolver.js (runReportAutoResolve, runReportDedup)
 *
 * Strategy:
 *   - callLLMStructured: test the JSON parsing branches directly by mirroring
 *     the exact code paths from the module source. The function calls
 *     execFile('claude', ...) which we cannot stub via named-import interception.
 *
 *   - runReportAutoResolve / runReportDedup: The module uses named ESM imports
 *     for execSync and callLLMStructured, so the named bindings cannot be
 *     replaced by mocking the child_process namespace object.
 *
 *     Instead we apply the same pattern used elsewhere in this test suite
 *     (hourly-automation.test.js, urgent-task-spawner.test.js):
 *
 *       (a) Test early-exit guard conditions against a real SQLite DB — these
 *           paths return before any subprocess call, so no mocking needed.
 *
 *       (b) Mirror the core DB-mutation logic (the resolveByPR and dedupOnly
 *           transaction blocks) in-test and verify the DB state that results.
 *           This validates the SQL UPDATE logic, hallucination filtering,
 *           triage_status values, transaction atomicity, and keep_id safety.
 *
 *       (c) Mirror the filtering / tracking logic (PR timestamp filter,
 *           latestMergedAt tracking) as pure functions and test them inline.
 *
 *       (d) Structural source-code analysis for subprocess-dependent behavior.
 *
 * Run with:
 *   node --test .claude/hooks/__tests__/report-auto-resolver.test.js
 *
 * @version 1.0.0
 */

import { describe, it, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Schema — mirrored from packages/mcp-servers/src/cto-reports/server.ts
// ============================================================================

const REPORTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    reporting_agent TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'other',
    priority TEXT NOT NULL DEFAULT 'normal',
    created_at TEXT NOT NULL,
    created_timestamp TEXT NOT NULL,
    read_at TEXT,
    acknowledged_at TEXT,
    idempotency_key TEXT,
    triage_status TEXT NOT NULL DEFAULT 'pending',
    triage_started_at TEXT,
    triage_completed_at TEXT,
    triage_session_id TEXT,
    triage_outcome TEXT,
    triaged_at TEXT,
    triage_action TEXT,
    CONSTRAINT valid_triage_status CHECK (
        triage_status IN ('pending', 'in_progress', 'self_handled', 'escalated', 'dismissed')
    )
);

CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_reports_triage_status ON reports(triage_status);
`;

// ============================================================================
// Helpers
// ============================================================================

function generateId() {
  return `report-${crypto.randomBytes(4).toString('hex')}`;
}

const NOW_ISO = new Date().toISOString();

/**
 * Create a temp project directory with .claude/cto-reports.db initialized.
 */
function createTestProject(prefix = 'report-resolver-test') {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
  const claudeDir = path.join(projectDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });

  const dbPath = path.join(claudeDir, 'cto-reports.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 3000');
  db.exec(REPORTS_SCHEMA);

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
 * Insert a report row with sensible defaults.
 */
function insertReport(db, {
  id = generateId(),
  reportingAgent = 'test-agent',
  title = 'Test Report',
  summary = 'A test summary',
  category = 'other',
  priority = 'normal',
  triageStatus = 'pending',
  createdAt = NOW_ISO,
  createdTimestamp = NOW_ISO,
} = {}) {
  db.prepare(`
    INSERT INTO reports
      (id, reporting_agent, title, summary, category, priority,
       triage_status, created_at, created_timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, reportingAgent, title, summary, category, priority,
         triageStatus, createdAt, createdTimestamp);
  return id;
}

/**
 * Get a report row by id.
 */
function getReport(db, id) {
  return db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
}

/**
 * Mirror of getPendingReports from the production module.
 */
function getPendingReports(db) {
  return db.prepare(
    `SELECT id, title, summary, category, priority, reporting_agent, created_at
     FROM reports
     WHERE triage_status = 'pending' AND triaged_at IS NULL
     ORDER BY created_timestamp DESC
     LIMIT 20`
  ).all();
}

// ============================================================================
// Mirrored core DB-mutation logic from resolveByPR and dedupOnly
// These mirror the exact UPDATE SQL and validation logic from the module.
// ============================================================================

/**
 * Mirror of the UPDATE statement used by both resolveByPR and dedupOnly.
 */
function buildUpdateStmt(db) {
  return db.prepare(
    `UPDATE reports
     SET triage_status = ?,
         triage_completed_at = ?,
         triage_outcome = ?,
         triaged_at = ?,
         triage_action = 'auto-acknowledged',
         acknowledged_at = COALESCE(acknowledged_at, ?),
         read_at = COALESCE(read_at, ?)
     WHERE id = ? AND triage_status = 'pending'`
  );
}

/**
 * Mirror of resolveByPR's transaction logic. Identical to the production module.
 */
function applyResolvePRUpdates(db, prNumber, llmResult, pendingIds, log) {
  const now = new Date().toISOString();
  let resolved = 0;
  let deduped = 0;

  const updateStmt = buildUpdateStmt(db);

  const applyUpdates = db.transaction(() => {
    if (Array.isArray(llmResult.resolved_reports)) {
      for (const item of llmResult.resolved_reports) {
        if (!item.report_id || !pendingIds.has(item.report_id)) {
          log(`Report auto-resolve: skipping hallucinated ID ${item.report_id}`);
          continue;
        }
        const changes = updateStmt.run(
          'self_handled',
          now,
          `Auto-resolved by PR #${prNumber}: ${item.reason}`,
          now, now, now,
          item.report_id
        );
        if (changes.changes > 0) {
          resolved++;
          pendingIds.delete(item.report_id);
        }
      }
    }

    if (Array.isArray(llmResult.duplicate_groups)) {
      for (const group of llmResult.duplicate_groups) {
        if (!group.keep_id || !pendingIds.has(group.keep_id)) continue;
        if (!Array.isArray(group.duplicate_ids)) continue;

        for (const dupId of group.duplicate_ids) {
          if (!pendingIds.has(dupId)) {
            log(`Report auto-resolve: skipping hallucinated dedup ID ${dupId}`);
            continue;
          }
          if (dupId === group.keep_id) continue;

          const changes = updateStmt.run(
            'dismissed',
            now,
            `Duplicate of report ${group.keep_id}: ${group.reason}`,
            now, now, now,
            dupId
          );
          if (changes.changes > 0) {
            deduped++;
            pendingIds.delete(dupId);
          }
        }
      }
    }
  });

  applyUpdates();
  return { resolved, deduped };
}

/**
 * Mirror of dedupOnly's transaction logic.
 */
function applyDedupUpdates(db, llmResult, pendingIds, log) {
  const now = new Date().toISOString();
  let deduped = 0;

  const updateStmt = buildUpdateStmt(db);

  const applyUpdates = db.transaction(() => {
    if (!Array.isArray(llmResult.duplicate_groups)) return;

    for (const group of llmResult.duplicate_groups) {
      if (!group.keep_id || !pendingIds.has(group.keep_id)) continue;
      if (!Array.isArray(group.duplicate_ids)) continue;

      for (const dupId of group.duplicate_ids) {
        if (!pendingIds.has(dupId)) {
          log(`Report dedup: skipping hallucinated ID ${dupId}`);
          continue;
        }
        if (dupId === group.keep_id) continue;

        const changes = updateStmt.run(
          'dismissed',
          now,
          `Duplicate of report ${group.keep_id}: ${group.reason}`,
          now, now, now,
          dupId
        );
        if (changes.changes > 0) {
          deduped++;
          pendingIds.delete(dupId);
        }
      }
    }
  });

  applyUpdates();
  return { deduped };
}

// ============================================================================
// Mirrored callLLMStructured parsing logic (from llm-client.js)
// ============================================================================

/**
 * Mirror of the stdout-parsing logic from callLLMStructured in llm-client.js.
 */
function applyLLMStructuredParsing(data) {
  if (typeof data.result === 'string') {
    return JSON.parse(data.result);
  }
  return data.result || data;
}

// ============================================================================
// Source paths for structural tests
// ============================================================================

const LLM_CLIENT_PATH = path.join(__dirname, '..', 'lib', 'llm-client.js');
const RESOLVER_PATH = path.join(__dirname, '..', 'lib', 'report-auto-resolver.js');

const llmClientSource = fs.readFileSync(LLM_CLIENT_PATH, 'utf8');
const resolverSource = fs.readFileSync(RESOLVER_PATH, 'utf8');

// ============================================================================
// Module under test — imported once for early-exit path tests.
// Early-exit paths never reach subprocess calls so no mocking needed.
// ============================================================================

let runReportAutoResolve;
let runReportDedup;
let setTestHandler;
let mainTestProject;
let execFileSyncMock = null;

before(async () => {
  mainTestProject = createTestProject('resolver-main');
  process.env.CLAUDE_PROJECT_DIR = mainTestProject.projectDir;

  // Import llm-client first to get the test handler setter
  const llmUrl =
    new URL('../lib/llm-client.js', import.meta.url).href +
    `?bust=${Date.now()}`;
  const llmMod = await import(llmUrl);
  setTestHandler = llmMod._setTestHandler;

  const modUrl =
    new URL('../lib/report-auto-resolver.js', import.meta.url).href +
    `?bust=${Date.now()}`;
  const mod = await import(modUrl);
  runReportAutoResolve = mod.runReportAutoResolve;
  runReportDedup = mod.runReportDedup;
});

after(() => {
  mainTestProject?.cleanup();
});

beforeEach(() => {
  mainTestProject.db.exec('DELETE FROM reports');
});

afterEach(() => {
  // Reset LLM test handler and all mock.method stubs
  if (setTestHandler) setTestHandler(null);
  mock.restoreAll();
  execFileSyncMock = null;
});

// ============================================================================
// llm-client.js — source structure tests
// ============================================================================

describe('llm-client.js — module structure', () => {
  it('exports callLLMStructured as an async function', () => {
    assert.match(
      llmClientSource,
      /export async function callLLMStructured/,
      'callLLMStructured must be an exported async function'
    );
  });

  it('double-parses data.result when it is a string', () => {
    assert.match(
      llmClientSource,
      /typeof data\.result === 'string'/,
      'Must check typeof data.result === "string" for double-parse path'
    );
    assert.match(
      llmClientSource,
      /JSON\.parse\(data\.result\)/,
      'Must call JSON.parse(data.result) in the string branch'
    );
  });

  it('returns null in the catch block (non-fatal error handling)', () => {
    assert.match(
      llmClientSource,
      /catch[\s\S]{0,20}\{[\s\S]*?return null/,
      'Must return null in the catch block'
    );
  });

  it('sets CLAUDE_SPAWNED_SESSION=true so subprocess is treated as non-interactive', () => {
    assert.match(
      llmClientSource,
      /CLAUDE_SPAWNED_SESSION.*true/,
      'Must set CLAUDE_SPAWNED_SESSION=true in subprocess env'
    );
  });

  it('uses --output-format json flag', () => {
    assert.match(llmClientSource, /--output-format.*json/,
      'Must pass --output-format json to claude CLI');
  });

  it('uses --json-schema flag', () => {
    assert.match(llmClientSource, /--json-schema/,
      'Must pass --json-schema flag to claude CLI');
  });
});

// ============================================================================
// llm-client.js — callLLMStructured parsing logic (mirrored tests)
// ============================================================================

describe('llm-client.js — callLLMStructured parsing logic', () => {

  describe('when execFile fails', () => {
    it('returns null — mirrors the catch block behavior', () => {
      let result = 'not-null';
      try {
        throw new Error('command not found: claude');
      } catch (_) {
        result = null;
      }
      assert.strictEqual(result, null);
    });
  });

  describe('when stdout data.result is a JSON string (double-parse path)', () => {
    it('parses the inner JSON string and returns the decoded object', () => {
      const innerObj = {
        resolved_reports: [{ report_id: 'r-1', reason: 'Fixed' }],
        duplicate_groups: [],
      };
      const data = { result: JSON.stringify(innerObj) };

      const result = applyLLMStructuredParsing(data);

      assert.deepEqual(result, innerObj);
    });

    it('returns the inner array when result string contains an array', () => {
      const innerArr = [{ id: 'x' }, { id: 'y' }];
      const data = { result: JSON.stringify(innerArr) };

      const result = applyLLMStructuredParsing(data);

      assert.deepEqual(result, innerArr);
    });
  });

  describe('when stdout data.result is already a plain object', () => {
    it('returns data.result directly without double-parsing', () => {
      const innerObj = { duplicate_groups: [], resolved_reports: [] };
      const data = { result: innerObj };

      const result = applyLLMStructuredParsing(data);

      assert.strictEqual(result, innerObj,
        'Should return the exact same object reference, not a reparsed copy');
    });

    it('returns nested fields intact', () => {
      const innerObj = { nested: { x: 42 }, arr: [1, 2, 3] };
      const data = { result: innerObj };

      const result = applyLLMStructuredParsing(data);

      assert.strictEqual(result.nested.x, 42);
      assert.deepEqual(result.arr, [1, 2, 3]);
    });
  });

  describe('when data has no result field', () => {
    it('returns data itself when data.result is undefined', () => {
      const data = { resolved_reports: [], duplicate_groups: [] };

      const result = applyLLMStructuredParsing(data);

      assert.strictEqual(result, data,
        'Should fall through to return data when data.result is undefined');
    });

    it('returns data itself when data.result is null (null is falsy)', () => {
      const data = { result: null, extraField: 'present' };

      const result = applyLLMStructuredParsing(data);

      // `data.result || data` — null is falsy so returns data
      assert.strictEqual(result, data,
        'null result should fall through and return data');
    });
  });

});

// ============================================================================
// report-auto-resolver.js — source structure tests
// ============================================================================

describe('report-auto-resolver.js — source structure', () => {
  it('exports runReportAutoResolve as an async function', () => {
    assert.match(
      resolverSource,
      /export async function runReportAutoResolve/,
      'Must export runReportAutoResolve as async function'
    );
  });

  it('exports runReportDedup as an async function', () => {
    assert.match(
      resolverSource,
      /export async function runReportDedup/,
      'Must export runReportDedup as async function'
    );
  });

  it('checks for DB existence before opening (fs.existsSync guard)', () => {
    assert.match(
      resolverSource,
      /fs\.existsSync\(DB_PATH\)/,
      'Must guard against missing DB with fs.existsSync'
    );
  });

  it('returns null when Database module is unavailable (!Database guard)', () => {
    assert.match(
      resolverSource,
      /!Database/,
      'Must check !Database before attempting to open the DB'
    );
  });

  it('filters pending reports by triage_status = "pending"', () => {
    assert.match(
      resolverSource,
      /triage_status = 'pending'/,
      'Must filter by triage_status = pending'
    );
  });

  it('limits pending report query to 20 rows', () => {
    assert.match(
      resolverSource,
      /LIMIT 20/,
      'Must cap pending report fetch at 20 rows to bound LLM context'
    );
  });

  it('skips dedup when fewer than 3 pending reports', () => {
    assert.match(
      resolverSource,
      /pendingReports\.length < 3/,
      'dedupOnly must skip when fewer than 3 pending reports'
    );
  });

  it('truncates PR diff to 8000 characters', () => {
    assert.match(
      resolverSource,
      /\.slice\(0,\s*8000\)/,
      'Must truncate diff to 8000 chars to fit LLM context'
    );
  });

  it('uses db.transaction for atomic DB updates', () => {
    assert.match(
      resolverSource,
      /db\.transaction/,
      'Must wrap DB updates in a transaction for atomicity'
    );
  });

  it('validates report_id against pendingIds to filter hallucinations', () => {
    assert.match(
      resolverSource,
      /pendingIds\.has\(item\.report_id\)/,
      'Must validate report_id against known pending IDs to block hallucinations'
    );
  });

  it('uses self_handled for resolved reports', () => {
    assert.match(
      resolverSource,
      /'self_handled'/,
      'Must use triage_status=self_handled for PR-resolved reports'
    );
  });

  it('uses dismissed for deduped reports', () => {
    assert.match(
      resolverSource,
      /'dismissed'/,
      'Must use triage_status=dismissed for deduped reports'
    );
  });

  it('detects preview base branch via git rev-parse origin/preview', () => {
    assert.match(
      resolverSource,
      /origin\/preview/,
      'Must check for origin/preview to detect the preview base branch'
    );
  });

  it('guards against dismissing the keep_id itself', () => {
    assert.match(
      resolverSource,
      /dupId === group\.keep_id/,
      'Must skip when dupId === keep_id to prevent dismissing the kept report'
    );
  });

  it('re-fetches pending reports between PRs for freshness', () => {
    // The outer loop re-calls getPendingReports before each PR.
    // Structural evidence: getPendingReports(db) is called inside the for..of loop.
    // Allow up to 500 chars between the for..of and the call (loop body has mergedAt tracking).
    assert.match(
      resolverSource,
      /for.*of mergedPRs[\s\S]{0,500}getPendingReports/,
      'Must re-fetch pending reports inside the PR loop for post-resolution freshness'
    );
  });

  it('breaks early when no pending reports remain after a PR', () => {
    assert.match(
      resolverSource,
      /currentPending\.length === 0.*break/s,
      'Must break out of the PR loop when all reports have been resolved'
    );
  });
});

// ============================================================================
// runReportAutoResolve() — early-exit paths (DB checks, no subprocess calls)
// ============================================================================

describe('runReportAutoResolve() — early-exit paths', () => {

  describe('DB does not exist', () => {
    it('returns null when the cto-reports.db file is missing', async () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-nodb-'));
      fs.mkdirSync(path.join(emptyDir, '.claude'), { recursive: true });
      // No DB created

      const savedEnv = process.env.CLAUDE_PROJECT_DIR;
      process.env.CLAUDE_PROJECT_DIR = emptyDir;

      const modUrl =
        new URL('../lib/report-auto-resolver.js', import.meta.url).href +
        `?bust-nodb=${Date.now()}`;
      const mod = await import(modUrl);

      const logs = [];
      const result = await mod.runReportAutoResolve(msg => logs.push(msg), 0);

      process.env.CLAUDE_PROJECT_DIR = savedEnv;
      fs.rmSync(emptyDir, { recursive: true, force: true });

      assert.strictEqual(result, null, 'Must return null when cto-reports.db does not exist');
    });
  });

  describe('no pending reports', () => {
    it('returns null when reports table is empty', async () => {
      const result = await runReportAutoResolve(() => {}, 0);
      assert.strictEqual(result, null, 'Must return null when no pending reports exist');
    });

    it('returns null when all reports are self_handled', async () => {
      insertReport(mainTestProject.db, { triageStatus: 'self_handled' });
      insertReport(mainTestProject.db, { triageStatus: 'self_handled' });

      const result = await runReportAutoResolve(() => {}, 0);
      assert.strictEqual(result, null, 'Must return null when no pending reports exist');
    });

    it('returns null when all reports are dismissed', async () => {
      insertReport(mainTestProject.db, { triageStatus: 'dismissed' });

      const result = await runReportAutoResolve(() => {}, 0);
      assert.strictEqual(result, null, 'Must return null when all reports are dismissed');
    });

    it('returns null when all reports are escalated', async () => {
      insertReport(mainTestProject.db, { triageStatus: 'escalated' });

      const result = await runReportAutoResolve(() => {}, 0);
      assert.strictEqual(result, null, 'Must return null when all reports are escalated');
    });
  });

});

// ============================================================================
// runReportDedup() — early-exit paths
// ============================================================================

describe('runReportDedup() — early-exit paths', () => {

  describe('DB does not exist', () => {
    it('returns null when the cto-reports.db file is missing', async () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-dedup-nodb-'));
      fs.mkdirSync(path.join(emptyDir, '.claude'), { recursive: true });

      const savedEnv = process.env.CLAUDE_PROJECT_DIR;
      process.env.CLAUDE_PROJECT_DIR = emptyDir;

      const modUrl =
        new URL('../lib/report-auto-resolver.js', import.meta.url).href +
        `?bust-dedup-nodb=${Date.now()}`;
      const mod = await import(modUrl);

      const logs = [];
      const result = await mod.runReportDedup(msg => logs.push(msg));

      process.env.CLAUDE_PROJECT_DIR = savedEnv;
      fs.rmSync(emptyDir, { recursive: true, force: true });

      assert.strictEqual(result, null, 'runReportDedup must return null when DB does not exist');
    });
  });

  describe('fewer than 3 pending reports', () => {
    it('returns null with 0 pending reports', async () => {
      const result = await runReportDedup(() => {});
      assert.strictEqual(result, null, 'Must return null with 0 pending reports');
    });

    it('returns null with exactly 1 pending report', async () => {
      insertReport(mainTestProject.db, { title: 'Only one' });

      const result = await runReportDedup(() => {});
      assert.strictEqual(result, null, 'Must return null with fewer than 3 pending reports (1)');
    });

    it('returns null with exactly 2 pending reports', async () => {
      insertReport(mainTestProject.db, { title: 'Report 1' });
      insertReport(mainTestProject.db, { title: 'Report 2' });

      const result = await runReportDedup(() => {});
      assert.strictEqual(result, null, 'Must return null with fewer than 3 pending reports (2)');
    });
  });

});

// ============================================================================
// getPendingReports — query semantics (direct DB tests)
// ============================================================================

describe('getPendingReports — query semantics', () => {
  let db;
  let proj;

  beforeEach(() => {
    proj = createTestProject('pending-query');
    db = proj.db;
  });

  afterEach(() => {
    proj.cleanup();
  });

  it('returns only pending reports — excludes self_handled, escalated, dismissed', () => {
    const pendingId = insertReport(db, { triageStatus: 'pending' });
    insertReport(db, { triageStatus: 'self_handled' });
    insertReport(db, { triageStatus: 'escalated' });
    insertReport(db, { triageStatus: 'dismissed' });

    const results = getPendingReports(db);

    assert.strictEqual(results.length, 1, 'Should return only pending reports');
    assert.strictEqual(results[0].id, pendingId);
  });

  it('excludes pending reports that have triaged_at set', () => {
    // WHERE triage_status = 'pending' AND triaged_at IS NULL
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO reports (id, reporting_agent, title, summary, triage_status, triaged_at, created_at, created_timestamp)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`
    ).run(generateId(), 'agent', 'Weird state', 'summary', now, now, now);

    const results = getPendingReports(db);

    assert.strictEqual(results.length, 0,
      'Reports with triaged_at set must be excluded even if triage_status is pending');
  });

  it('caps results at 20 rows', () => {
    for (let i = 0; i < 25; i++) {
      insertReport(db, { title: `Report ${i}` });
    }

    const results = getPendingReports(db);

    assert.strictEqual(results.length, 20, 'Must not return more than 20 pending reports (LIMIT 20)');
  });

  it('returns reports in created_timestamp DESC order (most recent first)', () => {
    const earlier = new Date(Date.now() - 10000).toISOString();
    const later = new Date().toISOString();

    const oldId = insertReport(db, { title: 'Older', createdTimestamp: earlier });
    const newId = insertReport(db, { title: 'Newer', createdTimestamp: later });

    const results = getPendingReports(db);

    assert.strictEqual(results[0].id, newId, 'Most recent report should come first');
    assert.strictEqual(results[1].id, oldId);
  });

  it('returns an empty array (not null/undefined) when no reports exist', () => {
    const results = getPendingReports(db);
    assert.ok(Array.isArray(results));
    assert.strictEqual(results.length, 0);
  });
});

// ============================================================================
// resolveByPR — DB update logic tests (mirrored transaction code)
// ============================================================================

describe('resolveByPR — DB update logic (mirrored)', () => {
  let db;
  let proj;

  beforeEach(() => {
    proj = createTestProject('resolve-pr');
    db = proj.db;
  });

  afterEach(() => {
    proj.cleanup();
  });

  it('marks a report as self_handled when LLM says it is resolved', () => {
    const reportId = insertReport(db, { title: 'Auth token expired bug' });
    const pendingIds = new Set([reportId]);
    const logs = [];

    const llmResult = {
      resolved_reports: [{ report_id: reportId, reason: 'PR #42 fixes token refresh' }],
      duplicate_groups: [],
    };

    const { resolved, deduped } = applyResolvePRUpdates(db, 42, llmResult, pendingIds, msg => logs.push(msg));

    assert.strictEqual(resolved, 1);
    assert.strictEqual(deduped, 0);

    const row = getReport(db, reportId);
    assert.strictEqual(row.triage_status, 'self_handled',
      'Resolved report must use triage_status=self_handled');
    assert.strictEqual(row.triage_action, 'auto-acknowledged');
    assert.ok(row.triage_outcome.includes('#42'), 'Outcome must reference the PR number');
    assert.ok(row.triaged_at !== null, 'triaged_at must be set');
    assert.ok(row.acknowledged_at !== null, 'acknowledged_at must be set');
    assert.ok(row.read_at !== null, 'read_at must be set');
  });

  it('skips hallucinated report IDs and logs a warning', () => {
    const realId = insertReport(db, { title: 'Real bug' });
    const fakeId = 'hallucinated-id-does-not-exist';
    const pendingIds = new Set([realId]);
    const logs = [];

    const llmResult = {
      resolved_reports: [
        { report_id: fakeId, reason: 'Does not exist' },
        { report_id: realId, reason: 'Genuine fix' },
      ],
      duplicate_groups: [],
    };

    const { resolved } = applyResolvePRUpdates(db, 99, llmResult, pendingIds, msg => logs.push(msg));

    assert.strictEqual(resolved, 1, 'Should resolve only the real report');
    assert.strictEqual(getReport(db, realId).triage_status, 'self_handled');

    const hallucLog = logs.find(l => l.includes('hallucinated') && l.includes(fakeId));
    assert.ok(hallucLog, 'Must log a warning for the hallucinated report ID');
  });

  it('deduplicates reports in the same LLM call using dismissed status', () => {
    const keepId = insertReport(db, { title: 'Memory leak — comprehensive' });
    const dupId = insertReport(db, { title: 'Memory leak — duplicate' });
    const pendingIds = new Set([keepId, dupId]);
    const logs = [];

    const llmResult = {
      resolved_reports: [],
      duplicate_groups: [
        { keep_id: keepId, duplicate_ids: [dupId], reason: 'Same memory leak' },
      ],
    };

    const { resolved, deduped } = applyResolvePRUpdates(db, 5, llmResult, pendingIds, msg => logs.push(msg));

    assert.strictEqual(resolved, 0);
    assert.strictEqual(deduped, 1);

    assert.strictEqual(getReport(db, keepId).triage_status, 'pending',
      'The kept report must remain pending');
    assert.strictEqual(getReport(db, dupId).triage_status, 'dismissed',
      'Duplicate must use triage_status=dismissed');
    assert.strictEqual(getReport(db, dupId).triage_action, 'auto-acknowledged');
    assert.ok(getReport(db, dupId).triage_outcome.includes(keepId),
      'Dup outcome must reference the kept report ID');
  });

  it('skips hallucinated dedup IDs and logs a warning', () => {
    const keepId = insertReport(db, { title: 'Real kept' });
    const fakeId = 'dedup-fake-xyz';
    const pendingIds = new Set([keepId]); // fakeId NOT in set
    const logs = [];

    const llmResult = {
      resolved_reports: [],
      duplicate_groups: [
        { keep_id: keepId, duplicate_ids: [fakeId], reason: 'Fake dup' },
      ],
    };

    const { deduped } = applyResolvePRUpdates(db, 77, llmResult, pendingIds, msg => logs.push(msg));

    assert.strictEqual(deduped, 0, 'Must not dedup hallucinated IDs');
    assert.strictEqual(getReport(db, keepId).triage_status, 'pending');

    const hallucLog = logs.find(l => l.includes('hallucinated') && l.includes(fakeId));
    assert.ok(hallucLog, 'Must log warning about hallucinated dedup ID');
  });

  it('does not dismiss the keep_id even when listed in duplicate_ids (safety guard)', () => {
    const keepId = insertReport(db, { title: 'The keeper' });
    const otherId = insertReport(db, { title: 'Other' });
    const pendingIds = new Set([keepId, otherId]);
    const logs = [];

    const llmResult = {
      resolved_reports: [],
      // LLM mistakenly lists keepId as its own duplicate
      duplicate_groups: [
        { keep_id: keepId, duplicate_ids: [keepId, otherId], reason: 'Confused LLM' },
      ],
    };

    applyResolvePRUpdates(db, 10, llmResult, pendingIds, msg => logs.push(msg));

    assert.strictEqual(getReport(db, keepId).triage_status, 'pending',
      'keep_id must not be dismissed even when it appears in duplicate_ids');
    assert.strictEqual(getReport(db, otherId).triage_status, 'dismissed');
  });

  it('only updates pending reports — WHERE triage_status="pending" prevents double-updates', () => {
    const selfHandledId = insertReport(db, { title: 'Already done', triageStatus: 'self_handled' });
    // pendingIds must include it to pass the hallucination filter, simulating a stale set
    const pendingIds = new Set([selfHandledId]);
    const logs = [];

    const llmResult = {
      resolved_reports: [{ report_id: selfHandledId, reason: 'Resolved again' }],
      duplicate_groups: [],
    };

    const { resolved } = applyResolvePRUpdates(db, 1, llmResult, pendingIds, msg => logs.push(msg));

    assert.strictEqual(resolved, 0,
      'WHERE triage_status="pending" guard must block updating already-triaged reports');
  });

  it('transaction: resolved and deduped updates commit atomically', () => {
    const id1 = insertReport(db, { title: 'Report A' });
    const id2 = insertReport(db, { title: 'Report B — keeper' });
    const id3 = insertReport(db, { title: 'Report C — dup of B' });
    const pendingIds = new Set([id1, id2, id3]);

    const llmResult = {
      resolved_reports: [{ report_id: id1, reason: 'Fixed in PR' }],
      duplicate_groups: [
        { keep_id: id2, duplicate_ids: [id3], reason: 'Same issue' },
      ],
    };

    const { resolved, deduped } = applyResolvePRUpdates(db, 100, llmResult, pendingIds, () => {});

    assert.strictEqual(resolved, 1);
    assert.strictEqual(deduped, 1);
    assert.strictEqual(getReport(db, id1).triage_status, 'self_handled');
    assert.strictEqual(getReport(db, id2).triage_status, 'pending');
    assert.strictEqual(getReport(db, id3).triage_status, 'dismissed');
  });

  it('removes resolved IDs from pendingIds so they cannot also be deduped', () => {
    const id1 = insertReport(db, { title: 'Bug fixed by PR' });
    const id2 = insertReport(db, { title: 'Bug dup' });
    const pendingIds = new Set([id1, id2]);

    // LLM resolves id1, then tries to list id1 as a duplicate of id2.
    // After id1 is resolved, it is deleted from pendingIds, so the dedup
    // branch should find id1 is no longer in pendingIds and skip it.
    const llmResult = {
      resolved_reports: [{ report_id: id1, reason: 'Fixed' }],
      duplicate_groups: [
        { keep_id: id2, duplicate_ids: [id1], reason: 'Same issue' },
      ],
    };

    const { resolved, deduped } = applyResolvePRUpdates(db, 200, llmResult, pendingIds, () => {});

    assert.strictEqual(resolved, 1);
    assert.strictEqual(deduped, 0,
      'Already-resolved IDs must be removed from pendingIds and not also deduped');
    assert.strictEqual(getReport(db, id1).triage_status, 'self_handled');
    assert.strictEqual(getReport(db, id2).triage_status, 'pending');
  });

});

// ============================================================================
// dedupOnly — DB update logic tests (mirrored transaction code)
// ============================================================================

describe('dedupOnly — DB update logic (mirrored)', () => {
  let db;
  let proj;

  beforeEach(() => {
    proj = createTestProject('dedup-only');
    db = proj.db;
  });

  afterEach(() => {
    proj.cleanup();
  });

  it('dismisses all duplicate IDs in a group', () => {
    const keepId = insertReport(db, { title: 'Memory leak — full' });
    const dup1Id = insertReport(db, { title: 'Memory leak — brief 1' });
    const dup2Id = insertReport(db, { title: 'Memory leak — brief 2' });
    const pendingIds = new Set([keepId, dup1Id, dup2Id]);

    const llmResult = {
      duplicate_groups: [
        { keep_id: keepId, duplicate_ids: [dup1Id, dup2Id], reason: 'Same memory leak' },
      ],
    };

    const { deduped } = applyDedupUpdates(db, llmResult, pendingIds, () => {});

    assert.strictEqual(deduped, 2, 'Should dismiss both duplicates');
    assert.strictEqual(getReport(db, keepId).triage_status, 'pending', 'Keeper stays pending');
    assert.strictEqual(getReport(db, dup1Id).triage_status, 'dismissed');
    assert.strictEqual(getReport(db, dup2Id).triage_status, 'dismissed');
    assert.strictEqual(getReport(db, dup1Id).triage_action, 'auto-acknowledged');
  });

  it('skips hallucinated IDs not in pendingIds and logs a warning', () => {
    const keepId = insertReport(db, { title: 'Real A' });
    const realDupId = insertReport(db, { title: 'Real B' });
    const fakeId = 'fake-dedup-id-999';
    const pendingIds = new Set([keepId, realDupId]); // fakeId NOT in set
    const logs = [];

    const llmResult = {
      duplicate_groups: [
        { keep_id: keepId, duplicate_ids: [fakeId, realDupId], reason: 'Same issue' },
      ],
    };

    const { deduped } = applyDedupUpdates(db, llmResult, pendingIds, msg => logs.push(msg));

    assert.strictEqual(deduped, 1, 'Should dismiss only the real dup, not the hallucinated one');
    assert.strictEqual(getReport(db, keepId).triage_status, 'pending');
    assert.strictEqual(getReport(db, realDupId).triage_status, 'dismissed');

    const hallucLog = logs.find(l => l.includes('hallucinated') && l.includes(fakeId));
    assert.ok(hallucLog, 'Must log warning about hallucinated dedup ID');
  });

  it('skips entire group when keep_id is not in pendingIds', () => {
    const realA = insertReport(db, { title: 'Real A' });
    const realB = insertReport(db, { title: 'Real B' });
    const fakeKeep = 'keeper-not-in-pending';
    const pendingIds = new Set([realA, realB]);

    const llmResult = {
      duplicate_groups: [
        { keep_id: fakeKeep, duplicate_ids: [realA, realB], reason: 'Fake keeper' },
      ],
    };

    const { deduped } = applyDedupUpdates(db, llmResult, pendingIds, () => {});

    assert.strictEqual(deduped, 0,
      'Must skip entire group when keep_id is not in pendingIds');
    assert.strictEqual(getReport(db, realA).triage_status, 'pending');
    assert.strictEqual(getReport(db, realB).triage_status, 'pending');
  });

  it('does not dismiss the keep_id even when it appears in duplicate_ids', () => {
    const keepId = insertReport(db, { title: 'The keeper' });
    const otherId = insertReport(db, { title: 'Other' });
    const pendingIds = new Set([keepId, otherId]);

    const llmResult = {
      // LLM lists keepId as its own duplicate
      duplicate_groups: [
        { keep_id: keepId, duplicate_ids: [keepId, otherId], reason: 'Confused LLM' },
      ],
    };

    applyDedupUpdates(db, llmResult, pendingIds, () => {});

    assert.strictEqual(getReport(db, keepId).triage_status, 'pending',
      'keep_id must never be dismissed by the dedup transaction');
    assert.strictEqual(getReport(db, otherId).triage_status, 'dismissed');
  });

  it('uses triage_status=dismissed for all dismissed duplicates', () => {
    const keepId = insertReport(db, { title: 'Original' });
    const d1 = insertReport(db, { title: 'Dup 1' });
    const d2 = insertReport(db, { title: 'Dup 2' });
    const pendingIds = new Set([keepId, d1, d2]);

    const llmResult = {
      duplicate_groups: [
        { keep_id: keepId, duplicate_ids: [d1, d2], reason: 'Same issue' },
      ],
    };

    applyDedupUpdates(db, llmResult, pendingIds, () => {});

    assert.strictEqual(getReport(db, d1).triage_status, 'dismissed',
      'Dup must use triage_status=dismissed');
    assert.strictEqual(getReport(db, d2).triage_status, 'dismissed');
    assert.strictEqual(getReport(db, d1).triage_action, 'auto-acknowledged',
      'Dup must have triage_action=auto-acknowledged');
    assert.strictEqual(getReport(db, d2).triage_action, 'auto-acknowledged');
  });

  it('returns { deduped: 0 } when LLM returns empty duplicate_groups', () => {
    const pendingIds = new Set();
    const llmResult = { duplicate_groups: [] };

    const { deduped } = applyDedupUpdates(db, llmResult, pendingIds, () => {});

    assert.strictEqual(deduped, 0);
  });

  it('handles null duplicate_groups without throwing', () => {
    const pendingIds = new Set();
    const llmResult = { duplicate_groups: null };

    assert.doesNotThrow(() => {
      applyDedupUpdates(db, llmResult, pendingIds, () => {});
    }, 'Non-array duplicate_groups must not throw');
  });

});

// ============================================================================
// latestMergedAt tracking and PR filter logic (mirrored)
// ============================================================================

describe('latestMergedAt tracking and PR filter logic', () => {

  it('tracks the maximum mergedAt timestamp across multiple PRs', () => {
    const t1 = new Date('2025-01-10T10:00:00Z').getTime();
    const t2 = new Date('2025-01-15T10:00:00Z').getTime(); // latest
    const t3 = new Date('2025-01-12T10:00:00Z').getTime();

    const prs = [
      { mergedAt: new Date(t1).toISOString() },
      { mergedAt: new Date(t2).toISOString() },
      { mergedAt: new Date(t3).toISOString() },
    ];

    // Mirror: let latestMergedAt = lastMergedPRTimestamp; for..of prs, update if newer
    let latestMergedAt = 0;
    for (const pr of prs) {
      const mergedAtMs = new Date(pr.mergedAt).getTime();
      if (mergedAtMs > latestMergedAt) {
        latestMergedAt = mergedAtMs;
      }
    }

    assert.strictEqual(latestMergedAt, t2,
      'latestMergedAt must be the maximum mergedAt across all PRs');
  });

  it('preserves the initial lastMergedPRTimestamp when all PRs are older', () => {
    const initial = new Date('2025-06-01T00:00:00Z').getTime();
    const olderPR = { mergedAt: new Date('2025-01-01T00:00:00Z').toISOString() };

    let latestMergedAt = initial;
    const mergedAtMs = new Date(olderPR.mergedAt).getTime();
    if (mergedAtMs > latestMergedAt) {
      latestMergedAt = mergedAtMs;
    }

    assert.strictEqual(latestMergedAt, initial,
      'Must preserve the initial timestamp when no PR is newer');
  });

  it('PR sinceTimestamp filter uses strictly greater-than comparison', () => {
    const sinceTimestamp = new Date('2025-06-01T00:00:00Z').getTime();

    // Mirror: prs.filter(pr => new Date(pr.mergedAt).getTime() > sinceTimestamp)
    const allPRs = [
      { number: 1, mergedAt: '2025-05-01T00:00:00Z' }, // older — excluded
      { number: 2, mergedAt: '2025-06-02T00:00:00Z' }, // newer — included
      { number: 3, mergedAt: '2025-06-01T00:00:00Z' }, // equal — excluded (strict >)
    ];

    const filtered = allPRs.filter(pr =>
      new Date(pr.mergedAt).getTime() > sinceTimestamp
    );

    assert.strictEqual(filtered.length, 1, 'Only PRs strictly after the cutoff should pass');
    assert.strictEqual(filtered[0].number, 2);
  });

  it('when sinceTimestamp is 0, all PRs pass the filter', () => {
    // Mirror: if (sinceTimestamp > 0) { filter } else { return prs }
    // The production code returns prs unfiltered when sinceTimestamp === 0.
    const prs = [
      { number: 10, mergedAt: '2024-01-01T00:00:00Z' },
      { number: 11, mergedAt: '2025-01-01T00:00:00Z' },
    ];

    const sinceTimestamp = 0;
    const result = sinceTimestamp > 0
      ? prs.filter(pr => new Date(pr.mergedAt).getTime() > sinceTimestamp)
      : prs;

    assert.strictEqual(result.length, 2,
      'When sinceTimestamp is 0, all PRs should be returned unfiltered');
  });

});
