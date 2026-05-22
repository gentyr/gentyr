#!/usr/bin/env node
/**
 * Token Usage Collector Daemon
 *
 * Scans Claude Code session JSONL files for assistant `message.usage`
 * objects and writes per-message token usage to `.claude/state/token-usage.db`.
 * Joins each session to `session-queue.db` (or marks as interactive / subprocess /
 * sub-agent / unknown) so token consumption can be aggregated by source, lane,
 * agent type, persistent task, plan, etc.
 *
 * Polling: every 60 seconds. KeepAlive launchd / systemd-user service.
 *
 * Backfill: on first run (empty scan_offsets) walks every JSONL file from
 * byte 0. Subsequent runs are incremental — each file's last byte offset is
 * persisted in the `scan_offsets` table.
 *
 * Retention:
 *   - usage_events:     90 days
 *   - subprocess_calls: 30 days
 *   - daily_rollup:     kept indefinitely
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';

import {
  encodeProjectPath,
  getSessionDir,
  listSessionFiles,
  parseUsageEventsIncremental,
  findAgentMarker,
  findUsageTagInJsonl,
  isSpawnedSession,
  readSubagentMeta,
  isCompactionSubagent,
} from '../.claude/hooks/lib/jsonl-usage-parser.js';
import { computeCostMicroUsd } from '../.claude/hooks/lib/token-pricing.js';
import {
  deriveWorkCategory,
  isRevivalSource,
  normalizeRevivalSource,
} from '../.claude/hooks/lib/work-category.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
try { process.chdir(PROJECT_DIR); } catch { /* non-fatal */ }

const STATE_DIR = path.join(PROJECT_DIR, '.claude', 'state');
const DB_PATH = path.join(STATE_DIR, 'token-usage.db');
const QUEUE_DB_PATH = path.join(STATE_DIR, 'session-queue.db');
const PERSISTENT_DB_PATH = path.join(STATE_DIR, 'persistent-tasks.db');
const PLANS_DB_PATH = path.join(STATE_DIR, 'plans.db');
const LOG_FILE = path.join(PROJECT_DIR, '.claude', 'token-usage-collector.log');

const POLL_INTERVAL_MS = 60_000;            // 1 minute
const USAGE_EVENTS_RETENTION_DAYS = 90;
const SUBPROCESS_CALLS_RETENTION_DAYS = 30;
const PENDING_RETRY_WINDOW_MS = 60 * 60 * 1000;  // 1 hour — retry pending attributions
const VACUUM_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // weekly

let pollTimer = null;
let shuttingDown = false;
let lastVacuumAt = 0;

// ============================================================================
// Logging
// ============================================================================

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // Fall back to stderr only as last resort
    process.stderr.write(line);
  }
}

// ============================================================================
// Schema
// ============================================================================

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  message_uuid TEXT,
  ts INTEGER NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micro_usd INTEGER NOT NULL DEFAULT 0,
  UNIQUE(session_id, message_uuid)
);
CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_events(session_id);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events(ts);
CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_events(model);

CREATE TABLE IF NOT EXISTS session_attribution (
  session_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  lane TEXT,
  agent_type TEXT,
  agent_id TEXT,
  queue_id TEXT,
  priority TEXT,
  category TEXT,
  task_id INTEGER,
  persistent_task_id INTEGER,
  plan_id TEXT,
  worktree_path TEXT,
  subprocess_tag TEXT,
  parent_session_id TEXT,
  is_subagent INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  ended_at INTEGER,
  attribution_status TEXT NOT NULL DEFAULT 'resolved',
  last_attempt_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_attr_source ON session_attribution(source);
CREATE INDEX IF NOT EXISTS idx_attr_pt ON session_attribution(persistent_task_id);
CREATE INDEX IF NOT EXISTS idx_attr_plan ON session_attribution(plan_id);
CREATE INDEX IF NOT EXISTS idx_attr_status ON session_attribution(attribution_status);

CREATE TABLE IF NOT EXISTS subprocess_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caller TEXT NOT NULL,
  model TEXT,
  parent_session_id TEXT,
  child_session_id TEXT,
  pid INTEGER,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  exit_code INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sub_caller ON subprocess_calls(caller);
CREATE INDEX IF NOT EXISTS idx_sub_child ON subprocess_calls(child_session_id);
CREATE INDEX IF NOT EXISTS idx_sub_started ON subprocess_calls(started_at);

CREATE TABLE IF NOT EXISTS scan_offsets (
  jsonl_path TEXT PRIMARY KEY,
  byte_offset INTEGER NOT NULL,
  last_scanned_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_rollup (
  date TEXT NOT NULL,
  source TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micro_usd INTEGER NOT NULL DEFAULT 0,
  session_count INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(date, source, model)
);
`;

/**
 * Idempotent ALTER TABLE ADD COLUMN. Swallows "duplicate column" errors so
 * the migration is safe to run on every open.
 */
function addColumnIfMissing(db, table, columnDef) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
  } catch (err) {
    if (!/duplicate column name/i.test(err.message)) throw err;
  }
}

/**
 * Open (and initialize) the token-usage DB.
 *
 * Schema migrations (run on every open, all idempotent):
 *   v1.0 — base schema (usage_events, session_attribution, ...)
 *   v1.1 — PR B columns on session_attribution:
 *           work_category    — stable kind-of-work (survives revival)
 *           spawn_origin     — original spawner of this WORK (not the latest
 *                              revival code path); see lib/work-category.js
 *           is_revival       — 1 when source is a revival code path
 *           revived_by       — normalized revival mechanism name
 *           revival_count    — how many queue items share this taskId/PT/plan
 */
export function openDb(dbPath = DB_PATH) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  // PR B columns — additive only, idempotent.
  addColumnIfMissing(db, 'session_attribution', 'work_category TEXT');
  addColumnIfMissing(db, 'session_attribution', 'spawn_origin TEXT');
  addColumnIfMissing(db, 'session_attribution', 'is_revival INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'session_attribution', 'revived_by TEXT');
  addColumnIfMissing(db, 'session_attribution', 'revival_count INTEGER NOT NULL DEFAULT 0');
  // Indexes for the new dimensions.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_attr_work_category ON session_attribution(work_category)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_attr_spawn_origin ON session_attribution(spawn_origin)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_attr_is_revival ON session_attribution(is_revival)`);
  return db;
}

// ============================================================================
// Attribution
// ============================================================================

/**
 * Open a read-only handle to an external DB, or null if it doesn't exist.
 */
function openReadonly(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return new Database(p, { readonly: true, fileMustExist: true });
  } catch (err) {
    log(`warn: failed to open ${p}: ${err.message}`);
    return null;
  }
}

/**
 * Chase the spawn origin of a piece of work through `queue_items`. For a
 * given workIdentifier (persistentTaskId > taskId > planId), find the
 * EARLIEST queue item matching it and return its source — that's the true
 * original spawner, independent of any revival code path that re-enqueued
 * the work later.
 *
 * Also returns `revival_count` (count of revival-source queue items for the
 * same work).
 *
 * Returns `{ spawnOrigin, revivalCount }` — both may be null/0 if no
 * workIdentifier is available or no rows match.
 */
function chaseSpawnOrigin(queueDb, { taskId, persistentTaskId, planId }) {
  if (!queueDb) return { spawnOrigin: null, revivalCount: 0 };
  const tryQuery = (jsonKey, value) => {
    if (value === null || value === undefined) return null;
    try {
      // Earliest source — the original spawn that started this work.
      const oldest = queueDb.prepare(
        `SELECT source FROM queue_items
         WHERE json_extract(metadata, '$.${jsonKey}') = ?
         ORDER BY enqueued_at ASC
         LIMIT 1`
      ).get(String(value));
      // Total queue items for this work — minus 1 for the original = revival count.
      const total = queueDb.prepare(
        `SELECT COUNT(*) AS n FROM queue_items
         WHERE json_extract(metadata, '$.${jsonKey}') = ?`
      ).get(String(value));
      return { oldestSource: oldest?.source || null, totalItems: total?.n || 0 };
    } catch (err) {
      log(`warn: chaseSpawnOrigin(${jsonKey}=${value}): ${err.message}`);
      return null;
    }
  };
  // Precedence: persistentTaskId > taskId > planId. PersistentTaskId is the
  // most specific (one persistent task = one piece of work); planId can map
  // to many persistent tasks.
  const sources = [
    tryQuery('persistentTaskId', persistentTaskId),
    tryQuery('taskId', taskId),
    tryQuery('planId', planId),
  ].filter(Boolean);
  if (sources.length === 0) return { spawnOrigin: null, revivalCount: 0 };
  // Prefer the first non-null oldestSource.
  const best = sources.find(s => s.oldestSource) || sources[0];
  // revival_count = totalItems - 1 (the original is not a revival).
  const revivalCount = Math.max(0, (best.totalItems || 0) - 1);
  return { spawnOrigin: best.oldestSource, revivalCount };
}

/**
 * Add the PR B fields (work_category, spawn_origin, is_revival, revived_by,
 * revival_count) to an attribution row.
 *
 * Falls back to the row's own `source` for `spawn_origin` when no
 * workIdentifier is available.
 */
function attachWorkCategoryFields(row, { sessionId, queueDb = null, queueRowMetadata = null }) {
  const isRev = isRevivalSource(row.source);
  const workCategory = deriveWorkCategory({
    agentType: row.agent_type,
    source: row.source,
    sessionId,
    isSubagent: !!row.is_subagent,
    metadata: queueRowMetadata,
  });
  let spawnOrigin = null;
  let revivalCount = 0;
  if (queueDb && queueRowMetadata) {
    const chase = chaseSpawnOrigin(queueDb, {
      taskId: queueRowMetadata.taskId,
      persistentTaskId: queueRowMetadata.persistentTaskId,
      planId: queueRowMetadata.planId,
    });
    spawnOrigin = chase.spawnOrigin;
    revivalCount = chase.revivalCount;
  }
  // Fallback: when we can't chase through a workIdentifier, the row's own
  // source is the spawn origin (it's the first and only known queue item).
  if (!spawnOrigin) spawnOrigin = row.source;
  return {
    ...row,
    work_category: workCategory,
    spawn_origin: spawnOrigin,
    is_revival: isRev ? 1 : 0,
    revived_by: isRev ? normalizeRevivalSource(row.source) : null,
    revival_count: revivalCount,
  };
}

/**
 * Resolve session attribution via the precedence chain documented in
 * /Users/jonathantodd/.claude/plans/foamy-dancing-cook.md.
 *
 * Returns the attribution row to insert (or null to defer as 'pending').
 */
export function resolveAttribution({
  sessionId,
  jsonlPath,
  isSubagent,
  parentSessionId,
  tokenDb,
}) {
  const now = Date.now();

  // Sub-agent JSONL — first priority: meta.json gives us agent_type
  if (isSubagent) {
    // `/compact` subprocess (no meta.json — spawned by Claude Code itself,
    // not the Agent tool). Distinct category so the cost is visible.
    if (isCompactionSubagent(sessionId)) {
      return attachWorkCategoryFields({
        session_id: sessionId,
        source: 'compaction-subagent',
        lane: 'subagent',
        agent_type: 'compaction',
        agent_id: null,
        queue_id: null,
        priority: null,
        category: null,
        task_id: null,
        persistent_task_id: null,
        plan_id: null,
        worktree_path: null,
        subprocess_tag: null,
        parent_session_id: parentSessionId,
        is_subagent: 1,
        started_at: now,
        ended_at: null,
        attribution_status: 'resolved',
        last_attempt_at: now,
      }, { sessionId });
    }
    const meta = readSubagentMeta(jsonlPath);
    // `readSubagentMeta` now normalizes camelCase `agentType` (the field
    // Claude Code actually writes) to `agent_type`. Pre-fix, the
    // mismatch dropped every Agent-tool subagent into `subagent:unknown`.
    const agentType = meta?.agent_type || 'unknown';
    return attachWorkCategoryFields({
      session_id: sessionId,
      source: `subagent:${agentType}`,
      lane: 'subagent',
      agent_type: agentType,
      agent_id: meta?.agent_id || null,
      queue_id: null,
      priority: null,
      category: null,
      task_id: null,
      persistent_task_id: null,
      plan_id: null,
      worktree_path: null,
      subprocess_tag: null,
      parent_session_id: parentSessionId,
      is_subagent: 1,
      started_at: now,
      ended_at: null,
      attribution_status: 'resolved',
      last_attempt_at: now,
    }, { sessionId });
  }

  // (1) Agent marker in JSONL -> queue_items.agent_id
  const queueDb = openReadonly(QUEUE_DB_PATH);
  const agentId = findAgentMarker(jsonlPath);

  let queueRow = null;
  if (queueDb) {
    try {
      if (agentId) {
        queueRow = queueDb.prepare(
          `SELECT id, source, lane, agent_type, agent_id, priority, metadata, worktree_path, spawned_at
           FROM queue_items
           WHERE agent_id = ?
           ORDER BY enqueued_at DESC
           LIMIT 1`
        ).get(agentId);
      }
      // (2) resume_session_id == session_id
      if (!queueRow) {
        queueRow = queueDb.prepare(
          `SELECT id, source, lane, agent_type, agent_id, priority, metadata, worktree_path, spawned_at
           FROM queue_items
           WHERE resume_session_id = ?
           ORDER BY enqueued_at DESC
           LIMIT 1`
        ).get(sessionId);
      }
    } catch (err) {
      log(`warn: queue lookup failed for ${sessionId}: ${err.message}`);
    } finally {
      try { queueDb.close(); } catch { /* non-fatal */ }
    }
  }

  if (queueRow) {
    let meta = {};
    try { meta = queueRow.metadata ? JSON.parse(queueRow.metadata) : {}; } catch { /* ignore */ }
    const row = {
      session_id: sessionId,
      source: queueRow.source,
      lane: queueRow.lane || null,
      agent_type: queueRow.agent_type || null,
      agent_id: queueRow.agent_id || agentId || null,
      queue_id: queueRow.id || null,
      priority: queueRow.priority || null,
      category: meta.category || null,
      task_id: meta.taskId || null,
      persistent_task_id: meta.persistentTaskId || null,
      plan_id: meta.planId || null,
      worktree_path: queueRow.worktree_path || null,
      subprocess_tag: null,
      parent_session_id: null,
      is_subagent: 0,
      started_at: queueRow.spawned_at ? Date.parse(queueRow.spawned_at) || now : now,
      ended_at: null,
      attribution_status: 'resolved',
      last_attempt_at: now,
    };
    // Reopen queue DB read-only for the spawn-origin chase. Cheap on SQLite
    // (local file, WAL); keeps the chase logic out of the lookup try/finally.
    const chaseDb = openReadonly(QUEUE_DB_PATH);
    try {
      return attachWorkCategoryFields(row, { sessionId, queueDb: chaseDb, queueRowMetadata: meta });
    } finally {
      try { chaseDb?.close(); } catch { /* non-fatal */ }
    }
  }

  // (3) subprocess_calls.child_session_id == session_id
  try {
    const sub = tokenDb.prepare(
      `SELECT id, caller, model, parent_session_id, pid, started_at
       FROM subprocess_calls
       WHERE child_session_id = ?
       ORDER BY started_at DESC
       LIMIT 1`
    ).get(sessionId);
    if (sub) {
      return attachWorkCategoryFields({
        session_id: sessionId,
        source: `subprocess:${sub.caller}`,
        lane: 'subprocess',
        agent_type: null,
        agent_id: null,
        queue_id: null,
        priority: null,
        category: null,
        task_id: null,
        persistent_task_id: null,
        plan_id: null,
        worktree_path: null,
        subprocess_tag: sub.caller,
        parent_session_id: sub.parent_session_id || null,
        is_subagent: 0,
        started_at: sub.started_at || now,
        ended_at: null,
        attribution_status: 'resolved',
        last_attempt_at: now,
      }, { sessionId });
    }
  } catch (err) {
    log(`warn: subprocess_calls lookup failed: ${err.message}`);
  }

  // (4) CLAUDE_USAGE_TAG in JSONL env dump
  const tagged = findUsageTagInJsonl(jsonlPath);
  if (tagged.tag) {
    return attachWorkCategoryFields({
      session_id: sessionId,
      source: `subprocess:${tagged.tag}`,
      lane: 'subprocess',
      agent_type: null,
      agent_id: null,
      queue_id: null,
      priority: null,
      category: null,
      task_id: null,
      persistent_task_id: null,
      plan_id: null,
      worktree_path: null,
      subprocess_tag: tagged.tag,
      parent_session_id: tagged.parentSessionId || null,
      is_subagent: 0,
      started_at: now,
      ended_at: null,
      attribution_status: 'resolved',
      last_attempt_at: now,
    }, { sessionId });
  }

  // (5) No marker, no queue, no subprocess, NOT a spawned session -> interactive CTO
  if (!isSpawnedSession(jsonlPath)) {
    return attachWorkCategoryFields({
      session_id: sessionId,
      source: 'interactive-cto',
      lane: 'interactive',
      agent_type: null,
      agent_id: null,
      queue_id: null,
      priority: null,
      category: null,
      task_id: null,
      persistent_task_id: null,
      plan_id: null,
      worktree_path: null,
      subprocess_tag: null,
      parent_session_id: null,
      is_subagent: 0,
      started_at: now,
      ended_at: null,
      attribution_status: 'resolved',
      last_attempt_at: now,
    }, { sessionId });
  }

  // (6) Pending — retry up to 1h, then freeze as 'unknown'
  return attachWorkCategoryFields({
    session_id: sessionId,
    source: 'unknown',
    lane: null,
    agent_type: null,
    agent_id: null,
    queue_id: null,
    priority: null,
    category: null,
    task_id: null,
    persistent_task_id: null,
    plan_id: null,
    worktree_path: null,
    subprocess_tag: null,
    parent_session_id: null,
    is_subagent: 0,
    started_at: now,
    ended_at: null,
    attribution_status: 'pending',
    last_attempt_at: now,
  }, { sessionId });
}

const ATTR_INSERT_COLUMNS = [
  'session_id', 'source', 'lane', 'agent_type', 'agent_id', 'queue_id',
  'priority', 'category', 'task_id', 'persistent_task_id', 'plan_id',
  'worktree_path', 'subprocess_tag', 'parent_session_id', 'is_subagent',
  'started_at', 'ended_at', 'attribution_status', 'last_attempt_at',
  // PR B columns
  'work_category', 'spawn_origin', 'is_revival', 'revived_by', 'revival_count',
];

function upsertAttribution(db, attr, { force = false } = {}) {
  const placeholders = ATTR_INSERT_COLUMNS.map(() => '?').join(', ');
  const values = ATTR_INSERT_COLUMNS.map(c => attr[c] ?? null);
  const updateGuard = force
    ? ''
    : `WHERE session_attribution.attribution_status != 'resolved'`;
  db.prepare(
    `INSERT INTO session_attribution (${ATTR_INSERT_COLUMNS.join(', ')})
     VALUES (${placeholders})
     ON CONFLICT(session_id) DO UPDATE SET
       source = excluded.source,
       lane = excluded.lane,
       agent_type = excluded.agent_type,
       agent_id = excluded.agent_id,
       queue_id = excluded.queue_id,
       priority = excluded.priority,
       category = excluded.category,
       task_id = excluded.task_id,
       persistent_task_id = excluded.persistent_task_id,
       plan_id = excluded.plan_id,
       worktree_path = excluded.worktree_path,
       subprocess_tag = excluded.subprocess_tag,
       parent_session_id = excluded.parent_session_id,
       is_subagent = excluded.is_subagent,
       ended_at = excluded.ended_at,
       attribution_status = excluded.attribution_status,
       last_attempt_at = excluded.last_attempt_at,
       work_category = excluded.work_category,
       spawn_origin = excluded.spawn_origin,
       is_revival = excluded.is_revival,
       revived_by = excluded.revived_by,
       revival_count = excluded.revival_count
     ${updateGuard}`
  ).run(...values);
}

/**
 * Backfill subagent attribution. Re-resolves rows that landed in
 * `subagent:unknown` due to the field-name mismatch bug (Claude Code writes
 * `agentType`; the collector previously read `agent_type`), and re-classifies
 * `agent-acompact-*` sessions as `compaction-subagent`. Idempotent — only
 * writes when the resolved source differs from the stored one. Tracks
 * progress in `meta` table so it runs once per database.
 */
export function backfillSubagentAttribution({
  projectDir = PROJECT_DIR,
  dbPath = DB_PATH,
  marker = 'subagent_backfill_v1',
} = {}) {
  const db = openDb(dbPath);
  let rewrote = 0;
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    const seen = db.prepare('SELECT value FROM meta WHERE key = ?').get(marker);
    if (seen) return { rewrote: 0, skipped: true };

    const rows = db.prepare(
      `SELECT session_id FROM session_attribution
       WHERE source = 'subagent:unknown' OR source LIKE 'subagent:%'
       OR (is_subagent = 1 AND agent_type = 'unknown')`
    ).all();

    if (rows.length === 0) {
      db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(marker, String(Date.now()));
      return { rewrote: 0, skipped: false };
    }

    // Build a path lookup: session_id -> { path, isSubagent, parentSessionId }
    const sessionDir = getSessionDir(projectDir);
    const files = listSessionFiles(sessionDir);
    const byId = new Map();
    for (const f of files) byId.set(f.sessionId, f);

    const tx = db.transaction(() => {
      for (const row of rows) {
        const file = byId.get(row.session_id);
        if (!file) continue;
        const attr = resolveAttribution({
          sessionId: file.sessionId,
          jsonlPath: file.path,
          isSubagent: file.isSubagent,
          parentSessionId: file.parentSessionId,
          tokenDb: db,
        });
        // Skip no-op rewrites — e.g., a subagent file whose meta.json is
        // genuinely missing AND is not a compaction subagent will still
        // resolve to `subagent:unknown`.
        const current = db.prepare(
          'SELECT source, agent_type FROM session_attribution WHERE session_id = ?'
        ).get(row.session_id);
        if (current && current.source === attr.source && current.agent_type === attr.agent_type) continue;
        upsertAttribution(db, attr, { force: true });
        rewrote++;
      }
      db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(marker, String(Date.now()));
    });
    tx();
  } finally {
    try { db.close(); } catch { /* non-fatal */ }
  }
  return { rewrote, skipped: false };
}

/**
 * Backfill work-category attribution. Walks all existing
 * `session_attribution` rows and computes `work_category`, `spawn_origin`,
 * `is_revival`, `revived_by`, and `revival_count` from the stored source +
 * agent_type + metadata fields — no JSONL reads required. Idempotent —
 * gated by a `meta` row so it runs once per database.
 */
export function backfillWorkCategoryAttribution({
  dbPath = DB_PATH,
  queueDbPath = QUEUE_DB_PATH,
  // v2 — bumped after the deriveWorkCategory() fix that (a) normalizes
  // hyphenated agent_type values to snake_case before comparison and
  // (b) maps source='interactive-cto' + hourly-automation block sources
  // to their proper categories. Re-runs once per installed DB to rewrite
  // rows previously stuck in the 'other' bucket.
  marker = 'work_category_backfill_v2',
} = {}) {
  const db = openDb(dbPath);
  let rewrote = 0;
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    const seen = db.prepare('SELECT value FROM meta WHERE key = ?').get(marker);
    if (seen) return { rewrote: 0, skipped: true };

    const rows = db.prepare(
      `SELECT session_id, source, agent_type, is_subagent, task_id, persistent_task_id, plan_id
       FROM session_attribution`
    ).all();

    const queueDb = openReadonly(queueDbPath);
    const update = db.prepare(
      `UPDATE session_attribution
       SET work_category = ?, spawn_origin = ?, is_revival = ?, revived_by = ?, revival_count = ?
       WHERE session_id = ?`
    );

    const tx = db.transaction(() => {
      for (const row of rows) {
        const metadata = {
          taskId: row.task_id,
          persistentTaskId: row.persistent_task_id,
          planId: row.plan_id,
        };
        const isRev = isRevivalSource(row.source);
        const workCategory = deriveWorkCategory({
          agentType: row.agent_type,
          source: row.source,
          sessionId: row.session_id,
          isSubagent: !!row.is_subagent,
          metadata,
        });
        let spawnOrigin = null;
        let revivalCount = 0;
        if (queueDb) {
          const chase = chaseSpawnOrigin(queueDb, metadata);
          spawnOrigin = chase.spawnOrigin;
          revivalCount = chase.revivalCount;
        }
        if (!spawnOrigin) spawnOrigin = row.source;
        update.run(
          workCategory,
          spawnOrigin,
          isRev ? 1 : 0,
          isRev ? normalizeRevivalSource(row.source) : null,
          revivalCount,
          row.session_id,
        );
        rewrote++;
      }
      db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(marker, String(Date.now()));
    });
    tx();

    try { queueDb?.close(); } catch { /* non-fatal */ }
  } finally {
    try { db.close(); } catch { /* non-fatal */ }
  }
  return { rewrote, skipped: false };
}

// ============================================================================
// Daily Rollup
// ============================================================================

function isoDate(tsMs) {
  return new Date(tsMs).toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Rebuild daily_rollup for a given date (default: today, UTC).
 */
export function rebuildDailyRollup(db, dateStr = isoDate(Date.now())) {
  const dayStart = Date.parse(`${dateStr}T00:00:00Z`);
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM daily_rollup WHERE date = ?').run(dateStr);
    db.prepare(`
      INSERT INTO daily_rollup
        (date, source, model,
         input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
         cost_micro_usd, session_count, message_count)
      SELECT
        ? AS date,
        COALESCE(sa.source, 'unknown') AS source,
        ue.model,
        SUM(ue.input_tokens),
        SUM(ue.output_tokens),
        SUM(ue.cache_creation_tokens),
        SUM(ue.cache_read_tokens),
        SUM(ue.cost_micro_usd),
        COUNT(DISTINCT ue.session_id),
        COUNT(*)
      FROM usage_events ue
      LEFT JOIN session_attribution sa ON sa.session_id = ue.session_id
      WHERE ue.ts >= ? AND ue.ts < ?
      GROUP BY source, ue.model
    `).run(dateStr, dayStart, dayEnd);
  });
  tx();
}

// ============================================================================
// Scan Cycle
// ============================================================================

/**
 * Single scan pass. Returns counts for logging.
 */
export function runScanCycle({ projectDir = PROJECT_DIR, dbPath = DB_PATH } = {}) {
  const db = openDb(dbPath);
  let newEvents = 0;
  let filesScanned = 0;
  let attributionsResolved = 0;
  let attributionsPending = 0;

  try {
    const sessionDir = getSessionDir(projectDir);
    const files = listSessionFiles(sessionDir);

    const insertEvent = db.prepare(
      `INSERT OR IGNORE INTO usage_events
         (session_id, message_uuid, ts, model,
          input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
          cost_micro_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const upsertOffset = db.prepare(
      `INSERT INTO scan_offsets (jsonl_path, byte_offset, last_scanned_at)
       VALUES (?, ?, ?)
       ON CONFLICT(jsonl_path) DO UPDATE SET byte_offset = excluded.byte_offset, last_scanned_at = excluded.last_scanned_at`
    );
    const getOffset = db.prepare('SELECT byte_offset FROM scan_offsets WHERE jsonl_path = ?');
    const getAttrStatus = db.prepare('SELECT attribution_status FROM session_attribution WHERE session_id = ?');

    for (const file of files) {
      filesScanned++;
      const offsetRow = getOffset.get(file.path);
      const startOffset = offsetRow?.byte_offset ?? 0;

      let result;
      try {
        result = parseUsageEventsIncremental(file.path, startOffset);
      } catch (err) {
        log(`warn: parse failed for ${file.path}: ${err.message}`);
        continue;
      }

      const tx = db.transaction(() => {
        for (const ev of result.events) {
          const tsMs = ev.timestamp ? (Date.parse(ev.timestamp) || Date.now()) : Date.now();
          const cost = computeCostMicroUsd(ev.model, ev, log);
          insertEvent.run(
            file.sessionId,
            ev.messageUuid,
            tsMs,
            ev.model,
            ev.input_tokens,
            ev.output_tokens,
            ev.cache_creation_tokens,
            ev.cache_read_tokens,
            cost,
          );
        }
        if (result.newOffset !== startOffset) {
          upsertOffset.run(file.path, result.newOffset, Date.now());
        }
      });
      tx();

      newEvents += result.events.length;

      // Resolve attribution if not already resolved
      const status = getAttrStatus.get(file.sessionId);
      if (!status || status.attribution_status === 'pending') {
        // Pending retry — only retry if it's been pending less than 1h
        if (status?.attribution_status === 'pending') {
          const existing = db.prepare('SELECT last_attempt_at FROM session_attribution WHERE session_id = ?').get(file.sessionId);
          if (existing && (Date.now() - existing.last_attempt_at) > PENDING_RETRY_WINDOW_MS) {
            // Freeze as unknown — stop retrying
            db.prepare(
              `UPDATE session_attribution SET attribution_status = 'unknown' WHERE session_id = ?`
            ).run(file.sessionId);
            continue;
          }
        }
        const attr = resolveAttribution({
          sessionId: file.sessionId,
          jsonlPath: file.path,
          isSubagent: file.isSubagent,
          parentSessionId: file.parentSessionId,
          tokenDb: db,
        });
        upsertAttribution(db, attr);
        if (attr.attribution_status === 'resolved') attributionsResolved++;
        else attributionsPending++;
      }
    }

    // Recompute today's rollup
    try {
      rebuildDailyRollup(db);
    } catch (err) {
      log(`warn: rollup rebuild failed: ${err.message}`);
    }

    // Retention pruning (cheap — bound to date ranges)
    try {
      const usageCutoff = Date.now() - USAGE_EVENTS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
      const pruneUsage = db.prepare('DELETE FROM usage_events WHERE ts < ?').run(usageCutoff);
      if (pruneUsage.changes > 0) log(`pruned ${pruneUsage.changes} usage_events older than ${USAGE_EVENTS_RETENTION_DAYS}d`);

      const subCutoff = Date.now() - SUBPROCESS_CALLS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
      const pruneSub = db.prepare('DELETE FROM subprocess_calls WHERE started_at < ?').run(subCutoff);
      if (pruneSub.changes > 0) log(`pruned ${pruneSub.changes} subprocess_calls older than ${SUBPROCESS_CALLS_RETENTION_DAYS}d`);
    } catch (err) {
      log(`warn: prune failed: ${err.message}`);
    }

    // Weekly vacuum
    if (Date.now() - lastVacuumAt > VACUUM_INTERVAL_MS) {
      try {
        db.exec('VACUUM');
        lastVacuumAt = Date.now();
        log('VACUUM complete');
      } catch (err) {
        log(`warn: VACUUM failed: ${err.message}`);
      }
    }
  } finally {
    try { db.close(); } catch { /* non-fatal */ }
  }

  return { newEvents, filesScanned, attributionsResolved, attributionsPending };
}

// ============================================================================
// Daemon Loop
// ============================================================================

function scheduleNextPoll() {
  if (shuttingDown) return;
  pollTimer = setTimeout(async () => {
    try {
      const result = runScanCycle();
      if (result.newEvents > 0 || result.attributionsResolved > 0) {
        log(`cycle: files=${result.filesScanned} new_events=${result.newEvents} attr_resolved=${result.attributionsResolved} attr_pending=${result.attributionsPending}`);
      }
    } catch (err) {
      log(`cycle error: ${err.stack || err.message}`);
    }
    scheduleNextPoll();
  }, POLL_INTERVAL_MS);
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`received ${signal}, shutting down`);
  if (pollTimer) clearTimeout(pollTimer);
  process.exit(0);
}

// ============================================================================
// Main
// ============================================================================

// Only run the daemon loop when executed directly (not when imported by tests)
if (import.meta.url === `file://${process.argv[1]}`) {
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    log(`uncaughtException: ${err.stack || err.message}`);
  });
  process.on('unhandledRejection', (reason) => {
    log(`unhandledRejection: ${reason}`);
  });

  log('token-usage-collector starting');
  log(`project_dir=${PROJECT_DIR} db=${DB_PATH} interval=${POLL_INTERVAL_MS}ms`);

  // One-time backfill: re-resolve subagent attribution that landed in
  // `subagent:unknown` due to the meta.json field-name bug, and reclassify
  // `agent-acompact-*` sessions as `compaction-subagent`. Idempotent —
  // gated by a `meta` row so it runs once per DB.
  try {
    const bf = backfillSubagentAttribution();
    if (!bf.skipped) {
      log(`subagent backfill: rewrote ${bf.rewrote} attribution rows`);
      // Force rollup rebuild so the report reflects the new sources today.
      try {
        const db = openDb();
        try { rebuildDailyRollup(db); } finally { db.close(); }
      } catch (err) {
        log(`warn: post-backfill rollup rebuild failed: ${err.message}`);
      }
    }
  } catch (err) {
    log(`backfill error: ${err.stack || err.message}`);
  }

  // PR B backfill: populate work_category, spawn_origin, is_revival,
  // revived_by, revival_count for all existing session_attribution rows.
  // Runs once per DB (gated by `work_category_backfill_v1` meta row).
  try {
    const bf2 = backfillWorkCategoryAttribution();
    if (!bf2.skipped) {
      log(`work-category backfill: populated ${bf2.rewrote} attribution rows`);
    }
  } catch (err) {
    log(`work-category backfill error: ${err.stack || err.message}`);
  }

  // Kick off first cycle immediately, then schedule
  try {
    const result = runScanCycle();
    log(`first cycle: files=${result.filesScanned} new_events=${result.newEvents} attr_resolved=${result.attributionsResolved} attr_pending=${result.attributionsPending}`);
  } catch (err) {
    log(`first cycle error: ${err.stack || err.message}`);
  }
  scheduleNextPoll();
}
