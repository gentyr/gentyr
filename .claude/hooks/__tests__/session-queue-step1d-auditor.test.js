/**
 * Tests for the auditor-aware branch of session-queue.js Step 1d.
 *
 * Background: when a universal-auditor / plan-auditor / authorization-auditor
 * dies after rendering a verdict (or while running), the dead candidate carries
 * agent_type='universal-auditor' (etc.) into reapSyncPass.revivalCandidates.
 * The legacy Step 1d propagated that agent_type into the revival queue item and
 * resumed from the auditor's JSONL using a task-runner prompt — mismatched.
 *
 * The new branch:
 *   1. Forces agent_type='task-runner' for any auditor candidate.
 *   2. Skips the dead auditor's session file; prefers --resume against the
 *      most recent NON-audit queue item for the task. Falls back to fresh.
 *   3. Tightens the dedup query to exclude lane='audit' so an active auditor
 *      doesn't block the needed task-runner revival.
 *   4. Records original/respawned agent types in metadata and the audit event.
 *
 * Uses the same structural + SQLite test pattern as session-queue-step1d.test.js.
 *
 * Run with: node --test .claude/hooks/__tests__/session-queue-step1d-auditor.test.js
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
const AUDITOR_PROMPT_PATH = path.resolve(__dirname, '..', 'lib', 'auditor-prompt.js');

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
`;

function generateId(prefix) {
  return `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
}

function createQueueDb() {
  const dbPath = path.join(
    os.tmpdir(),
    `sq-step1d-auditor-${Date.now()}-${crypto.randomBytes(2).toString('hex')}.db`
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

function insertHistoricalItem(db, { taskId, lane, spawnedAt, resumeSessionId, agentType = 'task-runner', status = 'completed' }) {
  const id = generateId('hist');
  db.prepare(`
    INSERT INTO queue_items
      (id, status, lane, spawn_type, title, agent_type, hook_type, tag_context, project_dir,
       source, metadata, spawned_at, resume_session_id)
    VALUES (?, ?, ?, 'fresh', ?, ?, 'session-reviver', 'test-ctx', '/tmp/test', 'test', ?, ?, ?)
  `).run(
    id,
    status,
    lane,
    `Hist ${id}`,
    agentType,
    JSON.stringify({ taskId }),
    spawnedAt,
    resumeSessionId
  );
  return id;
}

function insertRunningAudit(db, { taskId, spawnedAt = "datetime('now', '-5 minutes')" }) {
  const id = generateId('audit');
  db.prepare(`
    INSERT INTO queue_items
      (id, status, lane, spawn_type, title, agent_type, hook_type, tag_context, project_dir,
       source, metadata, spawned_at)
    VALUES (?, 'running', 'audit', 'fresh', ?, 'universal-auditor', 'session-reviver',
            'test-ctx', '/tmp/test', 'test', ?, ${spawnedAt})
  `).run(
    id,
    `Audit ${id}`,
    JSON.stringify({ taskId, taskType: 'todo' })
  );
  return id;
}

let sourceCode;
let auditorPromptSource;

before(() => {
  sourceCode = fs.readFileSync(SESSION_QUEUE_PATH, 'utf8');
  auditorPromptSource = fs.readFileSync(AUDITOR_PROMPT_PATH, 'utf8');
});

function getStep1dBody() {
  const marker = 'Step 1d: Re-enqueue dead non-persistent task agents';
  const start = sourceCode.indexOf(marker);
  assert.ok(start >= 0, 'Step 1d marker not found');
  const step2Marker = 'Step 2:';
  const end = sourceCode.indexOf(step2Marker, start);
  assert.ok(end >= 0, 'Step 2 marker not found after Step 1d');
  return sourceCode.slice(start, end);
}

// ============================================================================
// Tier 1: auditor-prompt.js exports the constant
// ============================================================================

describe('auditor-prompt.js — AUDITOR_AGENT_TYPES export', () => {
  it('exports AUDITOR_AGENT_TYPES', () => {
    assert.match(auditorPromptSource, /export const AUDITOR_AGENT_TYPES/);
  });

  it('AUDITOR_AGENT_TYPES is a Set containing the two auditor agent type strings', async () => {
    const mod = await import(AUDITOR_PROMPT_PATH);
    assert.ok(mod.AUDITOR_AGENT_TYPES instanceof Set, 'must be a Set');
    assert.ok(mod.AUDITOR_AGENT_TYPES.has('universal-auditor'));
    assert.ok(mod.AUDITOR_AGENT_TYPES.has('plan-auditor'));
    assert.equal(mod.AUDITOR_AGENT_TYPES.size, 2);
  });

  it('AUDITOR_AGENT_TYPES does NOT contain task-runner', async () => {
    const mod = await import(AUDITOR_PROMPT_PATH);
    assert.equal(mod.AUDITOR_AGENT_TYPES.has('task-runner'), false);
  });
});

// ============================================================================
// Tier 2: session-queue.js Step 1d imports the constant and branches on it
// ============================================================================

describe('session-queue.js Step 1d — source-code structural verification', () => {
  it('imports AUDITOR_AGENT_TYPES from auditor-prompt.js', () => {
    assert.match(
      sourceCode,
      /import\s*\{[^}]*AUDITOR_AGENT_TYPES[^}]*\}\s*from\s*['"]\.\/auditor-prompt\.js['"]/
    );
  });

  it('Step 1d detects auditor candidates via AUDITOR_AGENT_TYPES.has(candidate.agentType)', () => {
    const body = getStep1dBody();
    assert.match(body, /AUDITOR_AGENT_TYPES\.has\(candidate\.agentType\)/);
  });

  it('Step 1d dedup query excludes lane = audit', () => {
    const body = getStep1dBody();
    // Find the dedup SELECT and confirm it has lane != 'audit'
    const dedupMatch = body.match(/SELECT id FROM queue_items WHERE status IN \([^)]*\)[^"]*lane != 'audit'/);
    assert.ok(dedupMatch, 'Step 1d dedup must include lane != audit clause');
  });

  it('Step 1d forces revivalAgentType = task-runner for auditor candidates', () => {
    const body = getStep1dBody();
    assert.match(body, /candidateIsAuditor[\s\S]{0,200}revivalAgentType\s*=\s*['"]task-runner['"]/);
  });

  it('Step 1d looks up prior non-audit queue item for resume_session_id when candidate is auditor', () => {
    const body = getStep1dBody();
    // The SELECT for prior task-runner must filter to lane != 'audit'
    assert.match(
      body,
      /SELECT resume_session_id FROM queue_items[\s\S]*?lane != 'audit'/
    );
  });

  it('Step 1d INSERT uses revivalAgentType (not raw candidate.agentType)', () => {
    const body = getStep1dBody();
    // The INSERT block should reference revivalAgentType, not candidate.agentType for the agent_type column
    assert.match(body, /revivalAgentType/);
    // Confirm the legacy bare expression is gone from the INSERT
    assert.doesNotMatch(
      body,
      /VALUES[\s\S]*?candidate\.agentType\s*\|\|\s*candidate\.metadata\?\.agentType\s*\|\|\s*['"]task-runner['"]/
    );
  });

  it('Step 1d metadata records originalAgentType and respawnedAsType', () => {
    const body = getStep1dBody();
    assert.match(body, /originalAgentType/);
    assert.match(body, /respawnedAsType/);
  });

  it('Step 1d audit event reports original and respawned agent types', () => {
    const body = getStep1dBody();
    assert.match(body, /original_agent_type/);
    assert.match(body, /respawned_as_type/);
  });

  it('Step 1d revival metadata uses a distinct reason for auditor candidates', () => {
    const body = getStep1dBody();
    assert.match(body, /auditor_exit_task_needs_rework/);
  });
});

// ============================================================================
// Tier 3: dedup query semantics — lane != 'audit'
// ============================================================================

describe('Step 1d dedup query — audit-lane sessions do not block task-runner revival', () => {
  it('an active audit-lane item for the same taskId does NOT block revival', () => {
    const { db, cleanup } = createQueueDb();
    try {
      const taskId = generateId('task');
      insertRunningAudit(db, { taskId });

      const result = db.prepare(
        "SELECT id FROM queue_items WHERE status IN ('queued', 'running', 'spawning') AND lane != 'audit' AND json_extract(metadata, '$.taskId') = ?"
      ).get(taskId);

      assert.equal(result, undefined, 'audit-lane sessions must not be returned');
    } finally {
      cleanup();
    }
  });

  it('an active non-audit item for the same taskId DOES block revival', () => {
    const { db, cleanup } = createQueueDb();
    try {
      const taskId = generateId('task');
      db.prepare(`
        INSERT INTO queue_items
          (id, status, lane, spawn_type, title, agent_type, hook_type, tag_context,
           project_dir, source, metadata)
        VALUES ('q1', 'running', 'revival', 'fresh', 't', 'task-runner', 'h', 'c',
                '/tmp/x', 's', ?)
      `).run(JSON.stringify({ taskId }));

      const result = db.prepare(
        "SELECT id FROM queue_items WHERE status IN ('queued', 'running', 'spawning') AND lane != 'audit' AND json_extract(metadata, '$.taskId') = ?"
      ).get(taskId);

      assert.ok(result, 'non-audit revival lane sessions still block');
      assert.equal(result.id, 'q1');
    } finally {
      cleanup();
    }
  });
});

// ============================================================================
// Tier 4: prior-session lookup semantics
// ============================================================================

describe('Step 1d prior-session lookup — selects most recent non-audit run', () => {
  const LOOKUP_QUERY =
    "SELECT resume_session_id FROM queue_items " +
    "WHERE json_extract(metadata, '$.taskId') = ? AND lane != 'audit' " +
    "AND resume_session_id IS NOT NULL " +
    "ORDER BY spawned_at DESC LIMIT 1";

  it('returns the most recent non-audit resume_session_id', () => {
    const { db, cleanup } = createQueueDb();
    try {
      const taskId = generateId('task');
      const olderSid = '11111111-1111-1111-1111-111111111111';
      const newerSid = '22222222-2222-2222-2222-222222222222';

      insertHistoricalItem(db, {
        taskId, lane: 'standard',
        spawnedAt: '2026-05-22 20:00:00',
        resumeSessionId: olderSid,
      });
      insertHistoricalItem(db, {
        taskId, lane: 'revival',
        spawnedAt: '2026-05-22 21:00:00',
        resumeSessionId: newerSid,
      });

      const result = db.prepare(LOOKUP_QUERY).get(taskId);
      assert.ok(result, 'must find a result');
      assert.equal(result.resume_session_id, newerSid);
    } finally {
      cleanup();
    }
  });

  it('ignores audit-lane sessions even if they are the newest', () => {
    const { db, cleanup } = createQueueDb();
    try {
      const taskId = generateId('task');
      const taskRunnerSid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      const auditorSid = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

      insertHistoricalItem(db, {
        taskId, lane: 'standard',
        spawnedAt: '2026-05-22 20:00:00',
        resumeSessionId: taskRunnerSid,
      });
      insertHistoricalItem(db, {
        taskId, lane: 'audit',
        spawnedAt: '2026-05-22 22:00:00',
        resumeSessionId: auditorSid,
        agentType: 'universal-auditor',
      });

      const result = db.prepare(LOOKUP_QUERY).get(taskId);
      assert.ok(result);
      assert.equal(result.resume_session_id, taskRunnerSid, 'must return the older task-runner SID, not the auditor SID');
    } finally {
      cleanup();
    }
  });

  it('returns undefined when no non-audit session has a resume_session_id', () => {
    const { db, cleanup } = createQueueDb();
    try {
      const taskId = generateId('task');
      // Only an audit-lane historical session exists
      insertHistoricalItem(db, {
        taskId, lane: 'audit',
        spawnedAt: '2026-05-22 22:00:00',
        resumeSessionId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        agentType: 'universal-auditor',
      });
      const result = db.prepare(LOOKUP_QUERY).get(taskId);
      assert.equal(result, undefined);
    } finally {
      cleanup();
    }
  });

  it('returns undefined for a non-audit row that has no resume_session_id', () => {
    const { db, cleanup } = createQueueDb();
    try {
      const taskId = generateId('task');
      insertHistoricalItem(db, {
        taskId, lane: 'standard',
        spawnedAt: '2026-05-22 20:00:00',
        resumeSessionId: null,
      });
      const result = db.prepare(LOOKUP_QUERY).get(taskId);
      assert.equal(result, undefined);
    } finally {
      cleanup();
    }
  });
});
