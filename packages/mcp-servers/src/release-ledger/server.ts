#!/usr/bin/env node
/**
 * Release Ledger MCP Server
 *
 * Tracks production releases with PRs, sessions, reports, and tasks.
 * Provides a full evidence chain from staging lock through CTO sign-off.
 *
 * Database: .claude/state/release-ledger.db (SQLite, WAL mode)
 * Tier: 2 (stateful, per-session stdio)
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (stdio MCP)
 *
 * @version 1.0.0
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import Database from 'better-sqlite3';
import { McpServer, type AnyToolHandler } from '../shared/server.js';
import {
  CreateReleaseArgsSchema,
  GetReleaseArgsSchema,
  ListReleasesArgsSchema,
  UpdateReleaseArgsSchema,
  SignOffReleaseArgsSchema,
  CancelReleaseArgsSchema,
  AddReleasePrArgsSchema,
  UpdateReleasePrStatusArgsSchema,
  AddReleaseSessionArgsSchema,
  AddReleaseReportArgsSchema,
  AddReleaseTaskArgsSchema,
  GetReleaseEvidenceArgsSchema,
  GenerateReleaseReportArgsSchema,
  type CreateReleaseArgs,
  type GetReleaseArgs,
  type ListReleasesArgs,
  type UpdateReleaseArgs,
  type SignOffReleaseArgs,
  type CancelReleaseArgs,
  type AddReleasePrArgs,
  type UpdateReleasePrStatusArgs,
  type AddReleaseSessionArgs,
  type AddReleaseReportArgs,
  type AddReleaseTaskArgs,
  type GetReleaseEvidenceArgs,
  type GenerateReleaseReportArgs,
  LockStagingArgsSchema,
  UnlockStagingArgsSchema,
  type LockStagingArgs,
  type UnlockStagingArgs,
  OpenReleaseReportArgsSchema,
  GetReleaseReportSectionArgsSchema,
  PresentReleaseSummaryArgsSchema,
  type PresentReleaseSummaryArgs,
  RecordCtoApprovalArgsSchema,
  type RecordCtoApprovalArgs,
  type OpenReleaseReportArgs,
  type GetReleaseReportSectionArgs,
  type ReleaseRecord,
  type ReleasePrRecord,
  type ReleaseSessionRecord,
  type ReleaseReportRecord,
  type ReleaseTaskRecord,
  type ErrorResult,
} from './types.js';

// ============================================================================
// Configuration
// ============================================================================

const PROJECT_DIR = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'release-ledger.db');

// ============================================================================
// Database Schema
// ============================================================================

const SCHEMA = `
CREATE TABLE IF NOT EXISTS releases (
    id TEXT PRIMARY KEY,
    version TEXT,
    status TEXT NOT NULL DEFAULT 'in_progress',
    plan_id TEXT,
    persistent_task_id TEXT,
    staging_lock_at TEXT,
    staging_unlock_at TEXT,
    signed_off_at TEXT,
    signed_off_by TEXT,
    report_path TEXT,
    artifact_dir TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    metadata TEXT,
    CONSTRAINT valid_release_status CHECK (status IN ('in_progress','signed_off','cancelled'))
);

CREATE TABLE IF NOT EXISTS release_prs (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
    pr_number INTEGER NOT NULL,
    pr_title TEXT,
    pr_url TEXT,
    author TEXT,
    merged_at TEXT,
    review_status TEXT NOT NULL DEFAULT 'pending',
    review_plan_task_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    CONSTRAINT valid_pr_review_status CHECK (review_status IN ('pending','in_review','passed','failed'))
);

CREATE TABLE IF NOT EXISTS release_sessions (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
    queue_id TEXT,
    session_type TEXT,
    phase TEXT,
    target_pr INTEGER,
    status TEXT NOT NULL DEFAULT 'running',
    summary TEXT,
    started_at TEXT,
    completed_at TEXT,
    CONSTRAINT valid_session_status CHECK (status IN ('running','completed','failed'))
);

CREATE TABLE IF NOT EXISTS release_reports (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
    report_id TEXT,
    report_type TEXT,
    tier TEXT,
    title TEXT,
    outcome TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS release_tasks (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
    task_id TEXT,
    task_type TEXT,
    phase TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    CONSTRAINT valid_task_status CHECK (status IN ('pending','in_progress','completed','failed'))
);

CREATE INDEX IF NOT EXISTS idx_release_prs_release ON release_prs(release_id);
CREATE INDEX IF NOT EXISTS idx_release_sessions_release ON release_sessions(release_id);
CREATE INDEX IF NOT EXISTS idx_release_reports_release ON release_reports(release_id);
CREATE INDEX IF NOT EXISTS idx_release_tasks_release ON release_tasks(release_id);
CREATE INDEX IF NOT EXISTS idx_releases_status ON releases(status);
`;

// ============================================================================
// Database Management
// ============================================================================

let _db: Database.Database | null = null;

function initializeDatabase(): Database.Database {
  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);

  return db;
}

function getDb(): Database.Database {
  if (!_db) {
    _db = initializeDatabase();
  }
  return _db;
}

function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

function now(): string {
  return new Date().toISOString();
}

function shortUuid(): string {
  return randomUUID().split('-')[0];
}

function releaseExists(db: Database.Database, releaseId: string): ReleaseRecord | undefined {
  return db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId) as ReleaseRecord | undefined;
}

// ============================================================================
// Tool Implementations
// ============================================================================

/**
 * Create a new release record.
 * Auto-generates ID as `rel-<short-uuid>`.
 * Creates the artifact directory at `.claude/releases/{id}/` with manifest.json.
 */
function createRelease(args: CreateReleaseArgs): object {
  const db = getDb();
  const id = `rel-${shortUuid()}`;
  const ts = now();

  const metadata = args.metadata ? JSON.stringify(args.metadata) : null;

  db.prepare(
    `INSERT INTO releases (id, version, status, created_at, metadata)
     VALUES (?, ?, 'in_progress', ?, ?)`
  ).run(id, args.version ?? null, ts, metadata);

  // Create artifact directory with manifest
  const artifactDir = path.join(PROJECT_DIR, '.claude', 'releases', id);
  try {
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.mkdirSync(path.join(artifactDir, 'prs'), { recursive: true });
    fs.mkdirSync(path.join(artifactDir, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(artifactDir, 'reports'), { recursive: true });
    const manifest = {
      release_id: id,
      version: args.version ?? null,
      created_at: ts,
      metadata: args.metadata ?? null,
    };
    fs.writeFileSync(
      path.join(artifactDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
    );

    // Store artifact_dir on the release
    db.prepare('UPDATE releases SET artifact_dir = ? WHERE id = ?').run(artifactDir, id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[release-ledger] Warning: failed to create artifact directory: ${message}\n`);
  }

  return {
    id,
    version: args.version ?? null,
    status: 'in_progress',
    artifact_dir: artifactDir,
    created_at: ts,
  };
}

/**
 * Get a release with all related records.
 */
function getRelease(args: GetReleaseArgs): object | ErrorResult {
  const db = getDb();
  const release = releaseExists(db, args.release_id);

  if (!release) {
    return { error: `Release not found: ${args.release_id}` } as ErrorResult;
  }

  const prs = db.prepare(
    'SELECT * FROM release_prs WHERE release_id = ? ORDER BY created_at ASC'
  ).all(args.release_id) as ReleasePrRecord[];

  const sessions = db.prepare(
    'SELECT * FROM release_sessions WHERE release_id = ? ORDER BY started_at ASC'
  ).all(args.release_id) as ReleaseSessionRecord[];

  const reports = db.prepare(
    'SELECT * FROM release_reports WHERE release_id = ? ORDER BY created_at ASC'
  ).all(args.release_id) as ReleaseReportRecord[];

  const tasks = db.prepare(
    'SELECT * FROM release_tasks WHERE release_id = ? ORDER BY created_at ASC'
  ).all(args.release_id) as ReleaseTaskRecord[];

  return {
    ...release,
    metadata: release.metadata ? JSON.parse(release.metadata) : null,
    prs,
    sessions,
    reports,
    tasks,
  };
}

/**
 * List releases with optional status filter.
 */
function listReleases(args: ListReleasesArgs): object {
  const db = getDb();

  let query = 'SELECT * FROM releases';
  const params: unknown[] = [];

  if (args.status) {
    query += ' WHERE status = ?';
    params.push(args.status);
  }

  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(args.limit);

  const releases = db.prepare(query).all(...params) as ReleaseRecord[];

  const enriched = releases.map(release => {
    const prCount = (
      db.prepare('SELECT COUNT(*) as c FROM release_prs WHERE release_id = ?').get(release.id) as { c: number }
    ).c;
    const sessionCount = (
      db.prepare('SELECT COUNT(*) as c FROM release_sessions WHERE release_id = ?').get(release.id) as { c: number }
    ).c;
    const reportCount = (
      db.prepare('SELECT COUNT(*) as c FROM release_reports WHERE release_id = ?').get(release.id) as { c: number }
    ).c;
    const taskCount = (
      db.prepare('SELECT COUNT(*) as c FROM release_tasks WHERE release_id = ?').get(release.id) as { c: number }
    ).c;

    return {
      id: release.id,
      version: release.version,
      status: release.status,
      plan_id: release.plan_id,
      persistent_task_id: release.persistent_task_id,
      created_at: release.created_at,
      signed_off_at: release.signed_off_at,
      signed_off_by: release.signed_off_by,
      counts: {
        prs: prCount,
        sessions: sessionCount,
        reports: reportCount,
        tasks: taskCount,
      },
    };
  });

  return { releases: enriched, total: enriched.length };
}

/**
 * Register a PR in a release.
 */
function addReleasePr(args: AddReleasePrArgs): object | ErrorResult {
  const db = getDb();
  const release = releaseExists(db, args.release_id);
  if (!release) {
    return { error: `Release not found: ${args.release_id}` } as ErrorResult;
  }

  const id = `rpr-${shortUuid()}`;
  const ts = now();

  db.prepare(
    `INSERT INTO release_prs (id, release_id, pr_number, pr_title, pr_url, author, merged_at, review_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).run(id, args.release_id, args.pr_number, args.pr_title ?? null, args.pr_url ?? null, args.author ?? null, args.merged_at ?? null, ts);

  return {
    id,
    release_id: args.release_id,
    pr_number: args.pr_number,
    review_status: 'pending',
    created_at: ts,
  };
}

/**
 * Register a session in a release.
 */
function addReleaseSession(args: AddReleaseSessionArgs): object | ErrorResult {
  const db = getDb();
  const release = releaseExists(db, args.release_id);
  if (!release) {
    return { error: `Release not found: ${args.release_id}` } as ErrorResult;
  }

  const id = `rse-${shortUuid()}`;
  const ts = now();
  const status = args.status ?? 'running';

  db.prepare(
    `INSERT INTO release_sessions (id, release_id, queue_id, session_type, phase, target_pr, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, args.release_id, args.queue_id ?? null, args.session_type, args.phase, args.target_pr ?? null, status, ts);

  return {
    id,
    release_id: args.release_id,
    session_type: args.session_type,
    phase: args.phase,
    status,
    started_at: ts,
  };
}

/**
 * Register a report in a release.
 */
function addReleaseReport(args: AddReleaseReportArgs): object | ErrorResult {
  const db = getDb();
  const release = releaseExists(db, args.release_id);
  if (!release) {
    return { error: `Release not found: ${args.release_id}` } as ErrorResult;
  }

  const id = `rre-${shortUuid()}`;
  const ts = now();

  db.prepare(
    `INSERT INTO release_reports (id, release_id, report_id, report_type, tier, title, outcome, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, args.release_id, args.report_id ?? null, args.report_type, args.tier ?? null, args.title, args.outcome ?? null, ts);

  return {
    id,
    release_id: args.release_id,
    report_type: args.report_type,
    title: args.title,
    created_at: ts,
  };
}

/**
 * Register a task in a release.
 */
function addReleaseTask(args: AddReleaseTaskArgs): object | ErrorResult {
  const db = getDb();
  const release = releaseExists(db, args.release_id);
  if (!release) {
    return { error: `Release not found: ${args.release_id}` } as ErrorResult;
  }

  const id = `rta-${shortUuid()}`;
  const ts = now();
  const status = args.status ?? 'pending';

  db.prepare(
    `INSERT INTO release_tasks (id, release_id, task_id, task_type, phase, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, args.release_id, args.task_id ?? null, args.task_type, args.phase, status, ts);

  return {
    id,
    release_id: args.release_id,
    task_type: args.task_type,
    phase: args.phase,
    status,
    created_at: ts,
  };
}

/**
 * Update PR review status.
 */
function updateReleasePrStatus(args: UpdateReleasePrStatusArgs): object | ErrorResult {
  const db = getDb();
  const release = releaseExists(db, args.release_id);
  if (!release) {
    return { error: `Release not found: ${args.release_id}` } as ErrorResult;
  }

  const pr = db.prepare(
    'SELECT * FROM release_prs WHERE release_id = ? AND pr_number = ?'
  ).get(args.release_id, args.pr_number) as ReleasePrRecord | undefined;

  if (!pr) {
    return { error: `PR #${args.pr_number} not found in release ${args.release_id}` } as ErrorResult;
  }

  const updates: string[] = ['review_status = ?'];
  const values: (string | null)[] = [args.review_status];

  if (args.review_plan_task_id !== undefined) {
    updates.push('review_plan_task_id = ?');
    values.push(args.review_plan_task_id);
  }

  db.prepare(
    `UPDATE release_prs SET ${updates.join(', ')} WHERE release_id = ? AND pr_number = ?`
  ).run(...values, args.release_id, args.pr_number);

  return {
    release_id: args.release_id,
    pr_number: args.pr_number,
    old_review_status: pr.review_status,
    new_review_status: args.review_status,
    review_plan_task_id: args.review_plan_task_id ?? pr.review_plan_task_id,
  };
}

/**
 * Update release fields.
 */
function updateRelease(args: UpdateReleaseArgs): object | ErrorResult {
  const db = getDb();
  const release = releaseExists(db, args.release_id);
  if (!release) {
    return { error: `Release not found: ${args.release_id}` } as ErrorResult;
  }

  const updates: string[] = [];
  const values: (string | null)[] = [];

  if (args.plan_id !== undefined) {
    updates.push('plan_id = ?');
    values.push(args.plan_id);
  }
  if (args.persistent_task_id !== undefined) {
    updates.push('persistent_task_id = ?');
    values.push(args.persistent_task_id);
  }
  if (args.staging_lock_at !== undefined) {
    updates.push('staging_lock_at = ?');
    values.push(args.staging_lock_at);
  }
  if (args.staging_unlock_at !== undefined) {
    updates.push('staging_unlock_at = ?');
    values.push(args.staging_unlock_at);
  }
  if (args.status !== undefined) {
    updates.push('status = ?');
    values.push(args.status);
  }
  if (args.report_path !== undefined) {
    updates.push('report_path = ?');
    values.push(args.report_path);
  }
  if (args.artifact_dir !== undefined) {
    updates.push('artifact_dir = ?');
    values.push(args.artifact_dir);
  }
  if (args.version !== undefined) {
    updates.push('version = ?');
    values.push(args.version);
  }

  if (updates.length === 0) {
    return { error: 'No fields to update' } as ErrorResult;
  }

  db.prepare(
    `UPDATE releases SET ${updates.join(', ')} WHERE id = ?`
  ).run(...values, args.release_id);

  // Return updated release
  const updated = db.prepare('SELECT * FROM releases WHERE id = ?').get(args.release_id) as ReleaseRecord;
  return {
    id: updated.id,
    version: updated.version,
    status: updated.status,
    plan_id: updated.plan_id,
    persistent_task_id: updated.persistent_task_id,
    staging_lock_at: updated.staging_lock_at,
    staging_unlock_at: updated.staging_unlock_at,
    report_path: updated.report_path,
    artifact_dir: updated.artifact_dir,
  };
}

/**
 * Sign off on a release.
 * Sets status to 'signed_off' and records the signer and timestamp.
 */
function signOffRelease(args: SignOffReleaseArgs): object | ErrorResult {
  const db = getDb();
  const release = releaseExists(db, args.release_id);
  if (!release) {
    return { error: `Release not found: ${args.release_id}` } as ErrorResult;
  }

  if (release.status !== 'in_progress') {
    return { error: `Cannot sign off release in status '${release.status}' - must be 'in_progress'` } as ErrorResult;
  }

  const ts = now();
  db.prepare(
    "UPDATE releases SET status = 'signed_off', signed_off_at = ?, signed_off_by = ? WHERE id = ?"
  ).run(ts, args.signed_off_by, args.release_id);

  return {
    id: args.release_id,
    version: release.version,
    status: 'signed_off',
    signed_off_at: ts,
    signed_off_by: args.signed_off_by,
  };
}

/**
 * Cancel a release with optional comprehensive cleanup.
 *
 * When cleanup is true (default), performs:
 * 1. Cancel the release record
 * 2. Unlock staging
 * 3. Cancel the linked plan
 * 4. Cancel linked persistent tasks
 * 5. Cancel pending todo-db tasks
 * 6. Cancel running sessions linked to the release's tasks
 *
 * Each cleanup step is wrapped in try/catch so one failure does not block the others.
 */
function cancelRelease(args: CancelReleaseArgs): object | ErrorResult {
  const db = getDb();
  const release = releaseExists(db, args.release_id);
  if (!release) {
    return { error: `Release not found: ${args.release_id}` } as ErrorResult;
  }

  if (release.status !== 'in_progress') {
    return { error: `Cannot cancel release in status '${release.status}' - must be 'in_progress'` } as ErrorResult;
  }

  const cleanupErrors: string[] = [];

  // Step 1: Cancel the release record
  let metadataObj: Record<string, unknown> = {};
  try {
    if (release.metadata) metadataObj = JSON.parse(release.metadata);
  } catch { /* non-fatal */ }

  if (args.reason) {
    metadataObj.cancellation_reason = args.reason;
    metadataObj.cancelled_at = now();
  }

  db.prepare(
    "UPDATE releases SET status = 'cancelled', metadata = ? WHERE id = ?"
  ).run(JSON.stringify(metadataObj), args.release_id);

  // If cleanup is disabled, return immediately
  if (args.cleanup === false) {
    return {
      release_id: args.release_id,
      version: release.version,
      status: 'cancelled',
      reason: args.reason ?? null,
      cleanup: false,
    };
  }

  // Step 2: Unlock staging
  let stagingUnlocked = false;
  try {
    const stagingLockPath = path.join(PROJECT_DIR, '.claude', 'state', 'staging-lock.json');
    if (fs.existsSync(stagingLockPath)) {
      const lockState = {
        locked: false,
        release_id: args.release_id,
        unlocked_at: now(),
        unlocked_by: 'cancel_release',
      };
      fs.writeFileSync(stagingLockPath, JSON.stringify(lockState, null, 2));
      stagingUnlocked = true;

      // Update staging_unlock_at on the release record
      db.prepare('UPDATE releases SET staging_unlock_at = ? WHERE id = ?').run(now(), args.release_id);
    } else {
      stagingUnlocked = true; // No lock file means staging is already unlocked
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    cleanupErrors.push(`staging_unlock: ${message}`);
  }

  // Step 3: Cancel the linked plan
  let planCancelled = false;
  if (release.plan_id) {
    try {
      const plansDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'plans.db');
      if (fs.existsSync(plansDbPath)) {
        const plansDb = new Database(plansDbPath);
        plansDb.pragma('journal_mode = WAL');
        plansDb.pragma('busy_timeout = 5000');
        const result = plansDb.prepare(
          "UPDATE plans SET status = 'cancelled', completed_at = ? WHERE id = ? AND status != 'cancelled'"
        ).run(now(), release.plan_id);
        planCancelled = result.changes > 0;
        plansDb.close();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cleanupErrors.push(`plan_cancel: ${message}`);
    }
  }

  // Step 4: Cancel linked persistent tasks
  let persistentTasksCancelled = 0;
  if (release.plan_id) {
    try {
      const plansDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'plans.db');
      const ptDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
      if (fs.existsSync(plansDbPath) && fs.existsSync(ptDbPath)) {
        const plansDb = new Database(plansDbPath);
        plansDb.pragma('journal_mode = WAL');
        plansDb.pragma('busy_timeout = 5000');

        // Get all persistent_task_ids from plan_tasks AND the plan itself
        const planTaskPtIds = plansDb.prepare(
          'SELECT DISTINCT persistent_task_id FROM plan_tasks WHERE plan_id = ? AND persistent_task_id IS NOT NULL'
        ).all(release.plan_id) as Array<{ persistent_task_id: string }>;

        const planRecord = plansDb.prepare(
          'SELECT persistent_task_id FROM plans WHERE id = ?'
        ).get(release.plan_id) as { persistent_task_id: string | null } | undefined;

        plansDb.close();

        const ptIds = planTaskPtIds.map(r => r.persistent_task_id);
        if (planRecord?.persistent_task_id) {
          ptIds.push(planRecord.persistent_task_id);
        }

        if (ptIds.length > 0) {
          const ptDb = new Database(ptDbPath);
          ptDb.pragma('journal_mode = WAL');
          ptDb.pragma('busy_timeout = 5000');
          const cancelPt = ptDb.prepare(
            "UPDATE persistent_tasks SET status = 'cancelled' WHERE id = ? AND status NOT IN ('completed', 'cancelled')"
          );
          const cancelTx = ptDb.transaction(() => {
            for (const ptId of ptIds) {
              const r = cancelPt.run(ptId);
              persistentTasksCancelled += r.changes;
            }
          });
          cancelTx();
          ptDb.close();
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cleanupErrors.push(`persistent_tasks_cancel: ${message}`);
    }
  }

  // Step 5: Cancel pending todo-db tasks
  let todoTasksCancelled = 0;
  if (release.plan_id) {
    try {
      const plansDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'plans.db');
      const todoDbPath = path.join(PROJECT_DIR, '.claude', 'todo.db');
      if (fs.existsSync(plansDbPath) && fs.existsSync(todoDbPath)) {
        const plansDb = new Database(plansDbPath);
        plansDb.pragma('journal_mode = WAL');
        plansDb.pragma('busy_timeout = 5000');

        const todoTaskIds = plansDb.prepare(
          'SELECT DISTINCT todo_task_id FROM plan_tasks WHERE plan_id = ? AND todo_task_id IS NOT NULL'
        ).all(release.plan_id) as Array<{ todo_task_id: string }>;

        plansDb.close();

        if (todoTaskIds.length > 0) {
          const todoDb = new Database(todoDbPath);
          todoDb.pragma('journal_mode = WAL');
          todoDb.pragma('busy_timeout = 5000');
          // Mark incomplete tasks as completed with cancellation note rather than deleting them
          const cancelTodo = todoDb.prepare(
            "UPDATE tasks SET status = 'completed' WHERE id = ? AND status NOT IN ('completed')"
          );
          const cancelTx = todoDb.transaction(() => {
            for (const row of todoTaskIds) {
              const r = cancelTodo.run(row.todo_task_id);
              todoTasksCancelled += r.changes;
            }
          });
          cancelTx();
          todoDb.close();
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cleanupErrors.push(`todo_tasks_cancel: ${message}`);
    }
  }

  // Step 6: Cancel running sessions linked to the release's tasks
  let sessionsCancelled = 0;
  try {
    const queueDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'session-queue.db');
    if (fs.existsSync(queueDbPath)) {
      const queueDb = new Database(queueDbPath);
      queueDb.pragma('journal_mode = WAL');
      queueDb.pragma('busy_timeout = 5000');

      // Find running/queued/spawning sessions whose metadata references the release's plan
      // The metadata column stores JSON with taskId, persistentTaskId, planId, etc.
      const runningSessions = queueDb.prepare(
        "SELECT id, pid, metadata FROM queue_items WHERE status IN ('queued', 'spawning', 'running') AND metadata IS NOT NULL"
      ).all() as Array<{ id: string; pid: number | null; metadata: string }>;

      // Collect all known task IDs associated with this release
      const releaseTaskIds = new Set<string>();
      const releasePtIds = new Set<string>();

      if (release.plan_id) {
        try {
          const plansDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'plans.db');
          if (fs.existsSync(plansDbPath)) {
            const plansDb = new Database(plansDbPath);
            plansDb.pragma('journal_mode = WAL');
            plansDb.pragma('busy_timeout = 5000');

            const todoIds = plansDb.prepare(
              'SELECT todo_task_id FROM plan_tasks WHERE plan_id = ? AND todo_task_id IS NOT NULL'
            ).all(release.plan_id) as Array<{ todo_task_id: string }>;
            for (const r of todoIds) releaseTaskIds.add(r.todo_task_id);

            const ptIds = plansDb.prepare(
              'SELECT persistent_task_id FROM plan_tasks WHERE plan_id = ? AND persistent_task_id IS NOT NULL'
            ).all(release.plan_id) as Array<{ persistent_task_id: string }>;
            for (const r of ptIds) releasePtIds.add(r.persistent_task_id);

            const planRecord = plansDb.prepare(
              'SELECT persistent_task_id FROM plans WHERE id = ?'
            ).get(release.plan_id) as { persistent_task_id: string | null } | undefined;
            if (planRecord?.persistent_task_id) releasePtIds.add(planRecord.persistent_task_id);

            plansDb.close();
          }
        } catch {
          // Non-fatal: if we can't read plan data, we'll still cancel sessions by other identifiers
        }
      }

      const cancelSession = queueDb.prepare(
        "UPDATE queue_items SET status = 'cancelled', completed_at = ? WHERE id = ? AND status IN ('queued', 'spawning', 'running')"
      );

      const cancelTx = queueDb.transaction(() => {
        for (const session of runningSessions) {
          try {
            const meta = JSON.parse(session.metadata);
            const isReleasePlan = meta.planId === release.plan_id;
            const isReleaseTask = meta.taskId && releaseTaskIds.has(meta.taskId);
            const isReleasePt = meta.persistentTaskId && releasePtIds.has(meta.persistentTaskId);

            if (isReleasePlan || isReleaseTask || isReleasePt) {
              const r = cancelSession.run(now(), session.id);
              sessionsCancelled += r.changes;

              // Best-effort SIGTERM to the process
              if (session.pid) {
                try {
                  process.kill(session.pid, 'SIGTERM');
                } catch {
                  // Process may already be dead
                }
              }
            }
          } catch {
            // Skip sessions with unparseable metadata
          }
        }
      });

      cancelTx();
      queueDb.close();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    cleanupErrors.push(`sessions_cancel: ${message}`);
  }

  return {
    release_id: args.release_id,
    status: 'cancelled',
    staging_unlocked: stagingUnlocked,
    plan_cancelled: planCancelled,
    persistent_tasks_cancelled: persistentTasksCancelled,
    todo_tasks_cancelled: todoTasksCancelled,
    sessions_cancelled: sessionsCancelled,
    cleanup_errors: cleanupErrors,
  };
}

/**
 * Get the full evidence chain for a release.
 * Returns release record, all PRs with review status, all sessions with summaries,
 * all reports with outcomes, all tasks, counts and aggregations.
 */
function getReleaseEvidence(args: GetReleaseEvidenceArgs): object | ErrorResult {
  const db = getDb();
  const release = releaseExists(db, args.release_id);
  if (!release) {
    return { error: `Release not found: ${args.release_id}` } as ErrorResult;
  }

  const prs = db.prepare(
    'SELECT * FROM release_prs WHERE release_id = ? ORDER BY created_at ASC'
  ).all(args.release_id) as ReleasePrRecord[];

  const sessions = db.prepare(
    'SELECT * FROM release_sessions WHERE release_id = ? ORDER BY started_at ASC'
  ).all(args.release_id) as ReleaseSessionRecord[];

  const reports = db.prepare(
    'SELECT * FROM release_reports WHERE release_id = ? ORDER BY created_at ASC'
  ).all(args.release_id) as ReleaseReportRecord[];

  const tasks = db.prepare(
    'SELECT * FROM release_tasks WHERE release_id = ? ORDER BY created_at ASC'
  ).all(args.release_id) as ReleaseTaskRecord[];

  // PR review aggregation
  const prReviewCounts = {
    pending: prs.filter(p => p.review_status === 'pending').length,
    in_review: prs.filter(p => p.review_status === 'in_review').length,
    passed: prs.filter(p => p.review_status === 'passed').length,
    failed: prs.filter(p => p.review_status === 'failed').length,
  };

  // Session status aggregation
  const sessionStatusCounts = {
    running: sessions.filter(s => s.status === 'running').length,
    completed: sessions.filter(s => s.status === 'completed').length,
    failed: sessions.filter(s => s.status === 'failed').length,
  };

  // Task status aggregation
  const taskStatusCounts = {
    pending: tasks.filter(t => t.status === 'pending').length,
    in_progress: tasks.filter(t => t.status === 'in_progress').length,
    completed: tasks.filter(t => t.status === 'completed').length,
    failed: tasks.filter(t => t.status === 'failed').length,
  };

  // Session phase grouping
  const sessionsByPhase: Record<string, number> = {};
  for (const session of sessions) {
    const phase = session.phase ?? 'unknown';
    sessionsByPhase[phase] = (sessionsByPhase[phase] ?? 0) + 1;
  }

  // Report type grouping
  const reportsByType: Record<string, number> = {};
  for (const report of reports) {
    const rtype = report.report_type ?? 'unknown';
    reportsByType[rtype] = (reportsByType[rtype] ?? 0) + 1;
  }

  return {
    release: {
      ...release,
      metadata: release.metadata ? JSON.parse(release.metadata) : null,
    },
    prs,
    sessions,
    reports,
    tasks,
    counts: {
      prs: prs.length,
      sessions: sessions.length,
      reports: reports.length,
      tasks: tasks.length,
    },
    aggregations: {
      pr_review_status: prReviewCounts,
      session_status: sessionStatusCounts,
      task_status: taskStatusCounts,
      sessions_by_phase: sessionsByPhase,
      reports_by_type: reportsByType,
    },
  };
}

/**
 * Generate release report.
 *
 * Dynamically imports the release-report-generator module from the hooks
 * lib directory and calls generateStructuredReport with the release ID.
 */
async function generateReleaseReport(args: GenerateReleaseReportArgs): Promise<object> {
  const db = getDb();
  const release = releaseExists(db, args.release_id);
  if (!release) {
    return { error: `Release not found: ${args.release_id}` };
  }

  try {
    const reportGenPath = path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'release-report-generator.js');
    const { generateStructuredReport } = await import(reportGenPath);
    const result = await generateStructuredReport(args.release_id, PROJECT_DIR);

    // Store the report path on the release record
    if (result && result.mdPath) {
      db.prepare('UPDATE releases SET report_path = ? WHERE id = ?').run(result.mdPath, args.release_id);
    }

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Report generation failed: ${message}` };
  }
}

/**
 * Open a release report in the default application (macOS).
 *
 * If the report does not exist yet, generates it first via generateStructuredReport.
 */
async function openReleaseReport(args: OpenReleaseReportArgs): Promise<object> {
  const db = getDb();
  const release = releaseExists(db, args.release_id);
  if (!release) {
    return { error: `Release not found: ${args.release_id}` };
  }

  // Determine the report path
  const artifactDir = release.artifact_dir
    ? path.resolve(release.artifact_dir)
    : path.join(PROJECT_DIR, '.claude', 'releases', args.release_id);
  const reportPath = release.report_path || path.join(artifactDir, 'report.md');

  // Generate report if it does not exist
  let finalPath = reportPath;
  if (!fs.existsSync(reportPath)) {
    try {
      const reportGenPath = path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'release-report-generator.js');
      const { generateStructuredReport } = await import(reportGenPath);
      const result = await generateStructuredReport(args.release_id, PROJECT_DIR);
      if (result && result.mdPath) {
        db.prepare('UPDATE releases SET report_path = ? WHERE id = ?').run(result.mdPath, args.release_id);
        finalPath = result.mdPath;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Report generation failed: ${message}` };
    }
  }

  // Verify the report file exists after generation attempt
  if (!fs.existsSync(finalPath)) {
    return { error: `Report file not found at ${finalPath} even after generation attempt` };
  }

  // Open with macOS `open` command
  try {
    execSync(`open "${finalPath}"`, { timeout: 10000, stdio: 'pipe' });
    return { opened: true, path: finalPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to open report: ${message}`, path: finalPath };
  }
}

/**
 * Get a specific section from the release report.
 *
 * Parses the report.md and extracts the section matching the `## N.` header pattern.
 */
function getReleaseReportSection(args: GetReleaseReportSectionArgs): object {
  const db = getDb();
  const release = releaseExists(db, args.release_id);
  if (!release) {
    return { error: `Release not found: ${args.release_id}` };
  }

  const artifactDir = release.artifact_dir
    ? path.resolve(release.artifact_dir)
    : path.join(PROJECT_DIR, '.claude', 'releases', args.release_id);
  const reportPath = release.report_path || path.join(artifactDir, 'report.md');

  if (!fs.existsSync(reportPath)) {
    return { error: `Report not found at ${reportPath}. Call generate_release_report first.` };
  }

  const content = fs.readFileSync(reportPath, 'utf8');

  // Find the section header pattern: "## N." (e.g., "## 1.", "## 2.")
  const sectionNum = args.section;
  const sectionPattern = new RegExp(`^## ${sectionNum}\\.\\s`, 'm');
  const nextSectionPattern = new RegExp(`^## ${sectionNum + 1}\\.\\s`, 'm');

  const startMatch = sectionPattern.exec(content);
  if (!startMatch) {
    return { error: `Section ${sectionNum} not found in report. The report may use a different section numbering.` };
  }

  const startIndex = startMatch.index;
  const nextMatch = nextSectionPattern.exec(content.slice(startIndex + 1));

  let sectionContent: string;
  if (nextMatch) {
    sectionContent = content.slice(startIndex, startIndex + 1 + nextMatch.index).trim();
  } else {
    // Last section — take everything until end of file
    sectionContent = content.slice(startIndex).trim();
  }

  return {
    release_id: args.release_id,
    section: sectionNum,
    content: sectionContent,
  };
}

/**
 * Generate the release report, zip all artifacts, and return a summary for CTO review.
 * Call this BEFORE record_cto_approval.
 */
async function presentReleaseSummary(args: PresentReleaseSummaryArgs): Promise<string> {
  const db = getDb();
  const release = db.prepare('SELECT * FROM releases WHERE id = ?').get(args.release_id) as ReleaseRecord | undefined;
  if (!release) return JSON.stringify({ error: `Release not found: ${args.release_id}` });

  // Generate/regenerate the report
  let reportResult;
  try {
    const genModule = await import(path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'release-report-generator.js'));
    reportResult = await genModule.generateStructuredReport(args.release_id, PROJECT_DIR);
  } catch (err: unknown) {
    return JSON.stringify({ error: `Report generation failed: ${err instanceof Error ? err.message : String(err)}` });
  }

  // Update report_path in DB
  if (reportResult.mdPath) {
    db.prepare('UPDATE releases SET report_path = ? WHERE id = ?').run(reportResult.mdPath, args.release_id);
  }

  // Zip the artifact directory
  const artifactDir = release.artifact_dir || path.join(PROJECT_DIR, '.claude', 'releases', args.release_id);
  const zipPath = path.join(artifactDir, `release-${args.release_id}-artifacts.zip`);
  let zipOk = false;
  try {
    // Remove old zip first
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    execSync(`/usr/bin/zip -r "${zipPath}" . -x "*.zip"`, { cwd: artifactDir, timeout: 30000, stdio: 'pipe' });
    zipOk = fs.existsSync(zipPath);
  } catch {
    // Non-fatal — zip is a convenience
  }

  // Build summary from report content
  let summary = '';
  try {
    const reportContent = fs.readFileSync(reportResult.mdPath, 'utf8');
    // Extract key metrics from the report
    const prMatch = reportContent.match(/(\d+)\s+PR/i);
    const testMatch = reportContent.match(/(\d+)\s+passed.*?(\d+)\s+failed/i);
    const demoMatch = reportContent.match(/demo.*?(\d+).*?pass/i);
    const issueMatch = reportContent.match(/## 5\. Issues.*?\n([\s\S]*?)(?=## 6|$)/);

    const parts = [];
    parts.push(`Release ${release.version || args.release_id}`);
    if (prMatch) parts.push(`${prMatch[1]} PRs included`);
    if (testMatch) parts.push(`Tests: ${testMatch[1]} passed, ${testMatch[2]} failed`);
    if (demoMatch) parts.push(`Demos: ${demoMatch[0].slice(0, 80)}`);
    const issueCount = issueMatch ? (issueMatch[1].match(/\|/g) || []).length / 4 : 0;
    if (issueCount > 0) parts.push(`${Math.floor(issueCount)} issues resolved`);
    summary = parts.join(' | ');
  } catch {
    summary = `Release ${release.version || args.release_id} — report generated`;
  }

  return JSON.stringify({
    release_id: args.release_id,
    version: release.version,
    status: release.status,
    summary,
    report_path: reportResult.mdPath,
    pdf_path: reportResult.pdfPath || null,
    zip_path: zipOk ? zipPath : null,
    artifact_dir: artifactDir,
  });
}

/**
 * Record the CTO verbal approval with cryptographic proof.
 * Verifies the approval quote exists verbatim in the current session JSONL,
 * computes HMAC-SHA256 proof chain, archives the session transcript,
 * updates the release report with Section 9, and signs off the release.
 * Must call present_release_summary first.
 */
async function recordCtoApproval(args: RecordCtoApprovalArgs): Promise<string> {
  // Read approval tier from services.json (default: 'cto')
  let approvalTier = 'cto';
  try {
    const servicesPath = path.join(PROJECT_DIR, '.claude', 'config', 'services.json');
    if (fs.existsSync(servicesPath)) {
      const services = JSON.parse(fs.readFileSync(servicesPath, 'utf8'));
      approvalTier = services.releaseApprovalTier || 'cto';
    }
  } catch { /* default to cto */ }

  // Validate caller based on approval tier
  const isSpawned = process.env.CLAUDE_SPAWNED_SESSION === 'true';
  const isDeputyCto = process.env.GENTYR_DEPUTY_CTO === 'true';
  const isPlanManager = process.env.GENTYR_PLAN_MANAGER === 'true';

  if (approvalTier === 'cto') {
    // Original behavior: only interactive CTO sessions
    if (isSpawned) {
      return JSON.stringify({ error: 'Only interactive CTO sessions can sign off releases (releaseApprovalTier: "cto"). Spawned agents cannot call this tool.' });
    }
  } else if (approvalTier === 'deputy') {
    // CTO or deputy-CTO sessions
    if (isSpawned && !isDeputyCto) {
      return JSON.stringify({ error: 'Only CTO or deputy-CTO sessions can sign off releases (releaseApprovalTier: "deputy").' });
    }
  } else if (approvalTier === 'automated') {
    // Plan-manager can auto-sign-off
    if (isSpawned && !isPlanManager && !isDeputyCto) {
      return JSON.stringify({ error: 'Only CTO, deputy-CTO, or plan-manager sessions can sign off releases (releaseApprovalTier: "automated").' });
    }
  }

  // For automated tier, provide a default approval_text if not supplied
  const effectiveApprovalText = args.approval_text ||
    (approvalTier === 'automated' ? 'Automated sign-off: all quality gates passed' : '');
  if (!effectiveApprovalText || effectiveApprovalText.length < 10) {
    return JSON.stringify({ error: 'approval_text is required and must be at least 10 characters for non-automated sign-offs.' });
  }

  const db = getDb();
  const release = db.prepare('SELECT * FROM releases WHERE id = ?').get(args.release_id) as ReleaseRecord | undefined;
  if (!release) return JSON.stringify({ error: `Release not found: ${args.release_id}` });
  if (release.status !== 'in_progress') {
    return JSON.stringify({ error: `Release is already '${release.status}'. CTO approval can only be recorded on in_progress releases.` });
  }

  // Verify report exists (present_release_summary must be called first)
  const artifactDir = release.artifact_dir || path.join(PROJECT_DIR, '.claude', 'releases', args.release_id);
  const reportPath = path.join(artifactDir, 'report.md');
  if (!fs.existsSync(reportPath)) {
    return JSON.stringify({ error: 'No release report found. Call present_release_summary first to generate the report for CTO review.' });
  }

  // For the 'automated' tier with a spawned agent, skip the HMAC proof chain
  // and use plan completion evidence as the approval artifact instead.
  if (approvalTier === 'automated' && isSpawned) {
    const approvedAt = new Date().toISOString();
    const approverIdentity = isPlanManager ? 'plan-manager' : (isDeputyCto ? 'deputy-cto' : 'automated');

    // Write a simplified proof file (no HMAC — no interactive session to verify against)
    const proofData = {
      release_id: args.release_id,
      approval_tier: 'automated',
      approver: approverIdentity,
      approval_text: effectiveApprovalText,
      approved_at: approvedAt,
      note: 'Automated sign-off: HMAC proof chain not applicable. Plan completion evidence serves as the approval artifact.',
    };
    const proofPath = path.join(artifactDir, 'cto-approval.json');
    fs.writeFileSync(proofPath, JSON.stringify(proofData, null, 2));

    // Update report.md with Section 9
    try {
      let report = fs.readFileSync(reportPath, 'utf8');
      const approvalSection = [
        `**Approved by**: ${approverIdentity} (automated tier)`,
        `**Timestamp**: ${approvedAt}`,
        '',
        '**Approval text**:',
        `> ${effectiveApprovalText}`,
        '',
        '**Evidence**: Plan completion — all gate phases passed.',
        '',
        'Automated proof stored in `cto-approval.json`.',
      ].join('\n');

      if (report.includes('_Pending CTO approval._')) {
        report = report.replace('_Pending CTO approval._', approvalSection);
      } else if (report.includes('{cto_approval}')) {
        report = report.replace('{cto_approval}', approvalSection);
      } else {
        const footerIdx = report.lastIndexOf('---\n\n*Generated by GENTYR');
        if (footerIdx > 0) {
          report = report.slice(0, footerIdx) + '## 9. CTO Approval\n\n' + approvalSection + '\n\n' + report.slice(footerIdx);
        } else {
          report += '\n\n## 9. CTO Approval\n\n' + approvalSection + '\n';
        }
      }
      fs.writeFileSync(reportPath, report, 'utf8');
    } catch {
      // Non-fatal — proof file is the authoritative record
    }

    // Sign off the release
    try {
      db.prepare(
        'UPDATE releases SET status = ?, signed_off_at = ?, signed_off_by = ? WHERE id = ? AND status = ?'
      ).run('signed_off', approvedAt, approverIdentity, args.release_id, 'in_progress');
    } catch (err: unknown) {
      return JSON.stringify({ error: `Failed to sign off release: ${err instanceof Error ? err.message : String(err)}` });
    }

    return JSON.stringify({
      success: true,
      release_id: args.release_id,
      status: 'signed_off',
      approval_tier: 'automated',
      approved_at: approvedAt,
      approver: approverIdentity,
      proof_path: proofPath,
    });
  }

  // --- Full HMAC proof chain for 'cto' and 'deputy' tiers ---

  // Import the crypto module
  let proofModule;
  try {
    proofModule = await import(path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'cto-approval-proof.js'));
  } catch (err: unknown) {
    return JSON.stringify({ error: `Failed to load cto-approval-proof module: ${err instanceof Error ? err.message : String(err)}` });
  }

  // Find the current interactive session JSONL
  const session = proofModule.findCurrentSessionJsonl(PROJECT_DIR);
  if (!session) {
    return JSON.stringify({
      error: 'Cannot locate the current session JSONL file. Ensure you are running this from the interactive CTO session.',
      hint: `CLAUDE_SESSION_ID: ${process.env.CLAUDE_SESSION_ID || 'not set'}`,
    });
  }

  // TOCTOU defense: copy JSONL first (snapshot), then verify quote and hash the copy.
  // The live JSONL is actively written by Claude Code on every tool call, so we must
  // work from a stable snapshot to ensure the hash matches the verified content.
  const archivedJsonlName = 'cto-approval-session.jsonl';
  const archivedJsonlPath = path.join(artifactDir, archivedJsonlName);
  try {
    fs.copyFileSync(session.jsonlPath, archivedJsonlPath);
  } catch (err: unknown) {
    return JSON.stringify({ error: `Failed to archive session JSONL: ${err instanceof Error ? err.message : String(err)}` });
  }

  // Verify the quote exists verbatim in the ARCHIVED copy (not the live file)
  const quoteResult = await proofModule.verifyQuoteInJsonl(archivedJsonlPath, effectiveApprovalText);
  if (!quoteResult.found) {
    // Clean up the archived copy since verification failed
    try { fs.unlinkSync(archivedJsonlPath); } catch { /* non-fatal */ }
    return JSON.stringify({
      error: 'The approval text was not found verbatim in the current session transcript.',
      hint: 'The CTO must type their approval in this session before calling this tool. Type a clear approval message (e.g., "Approved for production"), then call this tool with that exact text.',
      session_id: session.sessionId,
    });
  }

  // Compute file hash of the ARCHIVED copy (stable snapshot)
  const fileHash = proofModule.computeFileHash(archivedJsonlPath);

  // Load protection key (G001 fail-closed)
  const keyBase64 = proofModule.loadProtectionKey(PROJECT_DIR);
  if (!keyBase64) {
    return JSON.stringify({ error: 'Protection key not found at .claude/protection-key. Cannot compute cryptographic proof (G001 fail-closed).' });
  }

  // Compute HMAC proof — binds to the archived copy's hash, not the live file
  const hmac = proofModule.computeApprovalHmac(keyBase64, args.release_id, session.sessionId, effectiveApprovalText, fileHash);
  const approvedAt = new Date().toISOString();

  // Write proof file
  const proofData = {
    release_id: args.release_id,
    session_id: session.sessionId,
    approval_text: effectiveApprovalText,
    line_number: quoteResult.lineNumber,
    session_file_hash: fileHash,
    hmac,
    approved_at: approvedAt,
    domain_separator: 'cto-release-approval',
    session_jsonl_archived: archivedJsonlName,
  };
  const proofPath = path.join(artifactDir, 'cto-approval.json');
  fs.writeFileSync(proofPath, JSON.stringify(proofData, null, 2));

  // Update report.md with Section 9
  try {
    let report = fs.readFileSync(reportPath, 'utf8');
    const approvalSection = [
      `**Approved by**: CTO`,
      `**Timestamp**: ${approvedAt}`,
      '',
      '**Verbatim approval**:',
      `> ${effectiveApprovalText}`,
      '',
      '**Evidence chain**:',
      `- Session transcript: \`${archivedJsonlName}\``,
      `- Session file SHA-256: \`${fileHash}\``,
      `- Approval HMAC proof: \`${hmac.slice(0, 16)}...\``,
      `- HMAC domain: \`cto-release-approval\``,
      '',
      'Full cryptographic proof chain stored in `cto-approval.json`.',
    ].join('\n');

    // Replace the pending placeholder or insert before footer
    if (report.includes('_Pending CTO approval._')) {
      report = report.replace('_Pending CTO approval._', approvalSection);
    } else if (report.includes('{cto_approval}')) {
      report = report.replace('{cto_approval}', approvalSection);
    } else {
      // Insert before the footer
      const footerIdx = report.lastIndexOf('---\n\n*Generated by GENTYR');
      if (footerIdx > 0) {
        report = report.slice(0, footerIdx) + '## 9. CTO Approval\n\n' + approvalSection + '\n\n' + report.slice(footerIdx);
      } else {
        report += '\n\n## 9. CTO Approval\n\n' + approvalSection + '\n';
      }
    }
    fs.writeFileSync(reportPath, report, 'utf8');
  } catch {
    // Non-fatal — proof file is the authoritative record
  }

  // Regenerate PDF
  try {
    const genModule = await import(path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'release-report-generator.js'));
    if (genModule.convertToPdf) {
      const pdfPath = path.join(artifactDir, 'report.pdf');
      await genModule.convertToPdf(reportPath, pdfPath);
    }
  } catch {
    // Non-fatal
  }

  // Re-zip artifacts
  try {
    const zipPath = path.join(artifactDir, `release-${args.release_id}-artifacts.zip`);
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    execSync(`/usr/bin/zip -r "${zipPath}" . -x "*.zip"`, { cwd: artifactDir, timeout: 30000, stdio: 'pipe' });
  } catch {
    // Non-fatal
  }

  // Sign off the release internally
  const signerIdentity = approvalTier === 'deputy' && isDeputyCto ? 'deputy-cto' : 'cto';
  try {
    db.prepare(
      'UPDATE releases SET status = ?, signed_off_at = ?, signed_off_by = ? WHERE id = ? AND status = ?'
    ).run('signed_off', approvedAt, signerIdentity, args.release_id, 'in_progress');
  } catch (err: unknown) {
    return JSON.stringify({ error: `Failed to sign off release: ${err instanceof Error ? err.message : String(err)}` });
  }

  return JSON.stringify({
    success: true,
    release_id: args.release_id,
    status: 'signed_off',
    approved_at: approvedAt,
    proof_path: proofPath,
    session_archived: archivedJsonlPath,
    hmac_preview: hmac.slice(0, 16) + '...',
  });
}

/**
 * Lock the staging branch to prevent new merges during a production release.
 * Writes the staging lock state file and optionally sets GitHub branch protection.
 */
function lockStagingTool(args: LockStagingArgs): object {
  const lockPath = path.join(PROJECT_DIR, '.claude', 'state', 'staging-lock.json');

  // Check if already locked by a different release
  try {
    if (fs.existsSync(lockPath)) {
      const existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (existing.locked && existing.release_id !== args.release_id) {
        return { error: `Staging is already locked by release ${existing.release_id}. Unlock it first or cancel that release.` };
      }
    }
  } catch { /* file doesn't exist or is corrupt, proceed */ }

  // Ensure state directory exists
  const stateDir = path.join(PROJECT_DIR, '.claude', 'state');
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }

  // Write lock file
  const lockedAt = now();
  const lockState = {
    locked: true,
    locked_at: lockedAt,
    locked_by: 'release-ledger',
    release_id: args.release_id,
    reason: 'Production release in progress',
  };
  fs.writeFileSync(lockPath, JSON.stringify(lockState, null, 2));

  // Best-effort GitHub branch protection
  let githubResult = 'skipped';
  try {
    execSync(
      'gh api repos/{owner}/{repo}/branches/staging/protection -X PUT -f required_pull_request_reviews.required_approving_review_count=6 2>/dev/null || true',
      { cwd: PROJECT_DIR, encoding: 'utf8', timeout: 15000, stdio: 'pipe' },
    );
    githubResult = 'set';
  } catch { githubResult = 'failed (non-fatal)'; }

  // Verify the lock was actually written correctly
  try {
    const verify = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (!verify.locked) {
      return { error: 'Lock file written but verification failed — locked is not true' };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Lock file verification failed: ${message}` };
  }

  return {
    locked: true,
    release_id: args.release_id,
    locked_at: lockedAt,
    github_protection: githubResult,
    lock_path: lockPath,
  };
}

/**
 * Unlock the staging branch after a production release completes or is cancelled.
 * Removes the staging lock state and GitHub branch protection.
 */
function unlockStagingTool(args: UnlockStagingArgs): object {
  const lockPath = path.join(PROJECT_DIR, '.claude', 'state', 'staging-lock.json');

  // Check current lock state — refuse to unlock a different release's lock
  try {
    if (fs.existsSync(lockPath)) {
      const existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (existing.locked && existing.release_id && existing.release_id !== args.release_id) {
        return { error: `Staging is locked by release ${existing.release_id}, not ${args.release_id}. Cannot unlock with a different release ID.` };
      }
    }
  } catch { /* proceed with unlock */ }

  // Write unlock state
  const unlockedAt = now();
  const unlockState = {
    locked: false,
    unlocked_at: unlockedAt,
    release_id: args.release_id,
  };
  fs.writeFileSync(lockPath, JSON.stringify(unlockState, null, 2));

  // Best-effort remove GitHub branch protection
  try {
    execSync(
      'gh api repos/{owner}/{repo}/branches/staging/protection -X DELETE 2>/dev/null || true',
      { cwd: PROJECT_DIR, encoding: 'utf8', timeout: 15000, stdio: 'pipe' },
    );
  } catch { /* non-fatal */ }

  return {
    locked: false,
    release_id: args.release_id,
    unlocked_at: unlockedAt,
  };
}

// ============================================================================
// Server Setup
// ============================================================================

const tools: AnyToolHandler[] = [
  {
    name: 'create_release',
    description: 'Create a new release record. Auto-generates ID as rel-<uuid>. Creates artifact directory at .claude/releases/{id}/ with manifest.json.',
    schema: CreateReleaseArgsSchema,
    handler: createRelease,
  },
  {
    name: 'get_release',
    description: 'Get a release with all related records (PRs, sessions, reports, tasks).',
    schema: GetReleaseArgsSchema,
    handler: getRelease,
  },
  {
    name: 'list_releases',
    description: 'List releases with optional status filter. Includes counts of related PRs, sessions, reports, and tasks.',
    schema: ListReleasesArgsSchema,
    handler: listReleases,
  },
  {
    name: 'add_release_pr',
    description: 'Register a PR in a release. Sets initial review_status to pending.',
    schema: AddReleasePrArgsSchema,
    handler: addReleasePr,
  },
  {
    name: 'add_release_session',
    description: 'Register a session in a release. Track code-reviewer, antipattern-hunter, user-alignment, and other session types by phase.',
    schema: AddReleaseSessionArgsSchema,
    handler: addReleaseSession,
  },
  {
    name: 'add_release_report',
    description: 'Register a report in a release. Links agent reports, triage actions, and CTO decisions to the release evidence chain.',
    schema: AddReleaseReportArgsSchema,
    handler: addReleaseReport,
  },
  {
    name: 'add_release_task',
    description: 'Register a task in a release. Track fix, demo_creation, test_fix, and other task types spawned during the release process.',
    schema: AddReleaseTaskArgsSchema,
    handler: addReleaseTask,
  },
  {
    name: 'update_release_pr_status',
    description: 'Update the review status of a PR in a release. Optionally link a review plan task ID.',
    schema: UpdateReleasePrStatusArgsSchema,
    handler: updateReleasePrStatus,
  },
  {
    name: 'update_release',
    description: 'Update release fields: plan_id, persistent_task_id, staging timestamps, status, report_path, artifact_dir, or version.',
    schema: UpdateReleaseArgsSchema,
    handler: updateRelease,
  },
  {
    name: 'sign_off_release',
    description: 'Sign off on a release. Sets status to signed_off with timestamp and signer identity. Only valid when status is in_progress.',
    schema: SignOffReleaseArgsSchema,
    handler: signOffRelease,
  },
  {
    name: 'cancel_release',
    description: 'Cancel a release and perform full cleanup: unlocks staging, cancels the linked plan and all associated persistent tasks, todo-db tasks, and running sessions. Use cleanup: false to only cancel the release record without side effects.',
    schema: CancelReleaseArgsSchema,
    handler: cancelRelease,
  },
  {
    name: 'get_release_evidence',
    description: 'Get the full evidence chain for a release: all PRs with review status, all sessions, all reports, all tasks, counts, and aggregations grouped by status/phase/type.',
    schema: GetReleaseEvidenceArgsSchema,
    handler: getReleaseEvidence,
  },
  {
    name: 'generate_release_report',
    description: 'Generate a structured markdown release report from the release evidence chain. Reads PRs, sessions, reports, tasks, and artifacts. Writes report.md to the release artifact directory and updates the release record with report_path.',
    schema: GenerateReleaseReportArgsSchema,
    handler: generateReleaseReport,
  },
  {
    name: 'open_release_report',
    description: 'Open the release report in the default application (macOS). Generates the report first if it does not exist yet.',
    schema: OpenReleaseReportArgsSchema,
    handler: openReleaseReport,
  },
  {
    name: 'get_release_report_section',
    description: 'Get a specific section (1-9) from a release report. Parses the report.md and extracts the content for the requested section number. Call generate_release_report first if the report does not exist.',
    schema: GetReleaseReportSectionArgsSchema,
    handler: getReleaseReportSection,
  },
  {
    name: 'lock_staging',
    description: 'Lock the staging branch to prevent new merges during a production release. Creates the staging lock state file and optionally sets GitHub branch protection. Must be called before activating a release plan.',
    schema: LockStagingArgsSchema,
    handler: lockStagingTool,
  },
  {
    name: 'unlock_staging',
    description: 'Unlock the staging branch after a production release completes or is cancelled. Removes the staging lock state and GitHub branch protection.',
    schema: UnlockStagingArgsSchema,
    handler: unlockStagingTool,
  },
  {
    name: 'present_release_summary',
    description: 'Generate the release report, zip all artifacts, and return a summary for CTO review. Call this BEFORE record_cto_approval. Returns report paths, artifact zip path, and a concise summary.',
    schema: PresentReleaseSummaryArgsSchema,
    handler: async (args: PresentReleaseSummaryArgs) => await presentReleaseSummary(args),
  },
  {
    name: 'record_cto_approval',
    description: 'Record the CTO verbal approval with cryptographic proof. Verifies the approval quote exists verbatim in the current session JSONL, computes HMAC-SHA256 proof chain, archives the session transcript, updates the release report with Section 9, and signs off the release. Must call present_release_summary first.',
    schema: RecordCtoApprovalArgsSchema,
    handler: async (args: RecordCtoApprovalArgs) => await recordCtoApproval(args),
  },
];

const server = new McpServer({
  name: 'release-ledger',
  version: '1.0.0',
  tools,
});

// Handle cleanup on exit
process.on('SIGINT', () => {
  closeDb();
  process.exit(0);
});

process.on('SIGTERM', () => {
  closeDb();
  process.exit(0);
});

server.start();
