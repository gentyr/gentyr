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
  OpenReleaseReportArgsSchema,
  GetReleaseReportSectionArgsSchema,
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
 * Cancel a release.
 * Sets status to 'cancelled'. Optionally stores reason in metadata.
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

  // Merge cancellation reason into metadata
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

  return {
    id: args.release_id,
    version: release.version,
    status: 'cancelled',
    reason: args.reason ?? null,
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
    description: 'Cancel a release. Sets status to cancelled and records reason. Only valid when status is in_progress.',
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
    description: 'Get a specific section (1-8) from a release report. Parses the report.md and extracts the content for the requested section number. Call generate_release_report first if the report does not exist.',
    schema: GetReleaseReportSectionArgsSchema,
    handler: getReleaseReportSection,
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
