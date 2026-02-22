#!/usr/bin/env node
/**
 * Agent Reports MCP Server
 *
 * Triage queue for agent reports. Agents submit reports here, which are then
 * triaged by the deputy-cto. Only deputy-cto can escalate items to the CTO queue.
 *
 * Flow: Agent → submit_report → Triage Queue → Deputy-CTO triages → (maybe) CTO Queue
 *
 * Features:
 * - Report creation with title, summary, category, priority
 * - List reports (titles/timestamps only to preserve tokens)
 * - Read report (expands full content)
 * - Triage lifecycle (pending → in_progress → completed)
 * - Auto-cleanup: 7 days expiry, max 50 items
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (stdio MCP)
 *
 * @version 2.0.0
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { McpServer, type AnyToolHandler } from '../shared/server.js';
import {
  ReportToCtoArgsSchema,
  ListReportsArgsSchema,
  GetUntriagedCountArgsSchema,
  ReadReportArgsSchema,
  AcknowledgeReportArgsSchema,
  MarkTriagedArgsSchema,
  StartTriageArgsSchema,
  CompleteTriageArgsSchema,
  GetTriageStatsArgsSchema,
  GetReportsForTriageArgsSchema,
  type ReportToCtoArgs,
  type ListReportsArgs,
  type GetUntriagedCountArgs,
  type ReadReportArgs,
  type AcknowledgeReportArgs,
  type MarkTriagedArgs,
  type StartTriageArgs,
  type CompleteTriageArgs,
  type GetTriageStatsArgs,
  type GetReportsForTriageArgs,
  type ReportRecord,
  type ReportListItem,
  type ListReportsResult,
  type GetUntriagedCountResult,
  type ReportToCtoResult,
  type ReadReportResult,
  type AcknowledgeReportResult,
  type MarkTriagedResult,
  type StartTriageResult,
  type CompleteTriageResult,
  type GetTriageStatsResult,
  type GetReportsForTriageResult,
  type ErrorResult,
  type TriageAction,
  type TriageStatus,
} from './types.js';

// ============================================================================
// Configuration
// ============================================================================

const PROJECT_DIR = path.resolve(process.env['CLAUDE_PROJECT_DIR'] || process.cwd());
const DB_PATH = path.join(PROJECT_DIR, '.claude', 'cto-reports.db');

// Cleanup thresholds
const MAX_REPORTS = 50;
const MAX_AGE_DAYS = 7;

// ============================================================================
// Database Schema
// ============================================================================

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    reporting_agent TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'other',
    priority TEXT NOT NULL DEFAULT 'normal',
    created_at TEXT NOT NULL,
    created_timestamp INTEGER NOT NULL,
    read_at TEXT,
    acknowledged_at TEXT,
    -- Triage lifecycle fields
    triage_status TEXT NOT NULL DEFAULT 'pending',
    triage_started_at TEXT,
    triage_completed_at TEXT,
    triage_session_id TEXT,
    triage_outcome TEXT,
    triage_attempted_at TEXT,  -- Last attempt timestamp (for cooldown tracking)
    -- Legacy fields (for backward compatibility)
    triaged_at TEXT,
    triage_action TEXT,
    CONSTRAINT valid_category CHECK (category IN ('architecture', 'security', 'performance', 'breaking-change', 'blocker', 'decision', 'user-feedback', 'other')),
    CONSTRAINT valid_priority CHECK (priority IN ('low', 'normal', 'high', 'critical')),
    CONSTRAINT valid_triage_status CHECK (triage_status IN ('pending', 'in_progress', 'self_handled', 'escalated', 'dismissed'))
);

CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_reports_acknowledged ON reports(acknowledged_at);
CREATE INDEX IF NOT EXISTS idx_reports_triage_status ON reports(triage_status);
CREATE INDEX IF NOT EXISTS idx_reports_triage_completed ON reports(triage_completed_at);
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
  db.exec(SCHEMA);

  // Idempotent index creation
  db.exec('CREATE INDEX IF NOT EXISTS idx_reports_triage_status ON reports(triage_status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_reports_triage_completed ON reports(triage_completed_at)');

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
// Cleanup Logic
// ============================================================================

function runCleanup(): { deleted_old: number; deleted_excess: number } {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const maxAge = MAX_AGE_DAYS * 24 * 60 * 60;
  const cutoff = now - maxAge;

  // Delete reports older than 7 days
  const oldResult = db.prepare(`
    DELETE FROM reports WHERE created_timestamp < ?
  `).run(cutoff);

  // Delete excess reports (keep most recent 50)
  interface CountResult { count: number }
  const countResult = db.prepare('SELECT COUNT(*) as count FROM reports').get() as CountResult;
  let deletedExcess = 0;

  if (countResult.count > MAX_REPORTS) {
    const toDelete = countResult.count - MAX_REPORTS;
    const excessResult = db.prepare(`
      DELETE FROM reports WHERE id IN (
        SELECT id FROM reports
        ORDER BY created_timestamp ASC
        LIMIT ?
      )
    `).run(toDelete);
    deletedExcess = excessResult.changes;
  }

  return {
    deleted_old: oldResult.changes,
    deleted_excess: deletedExcess,
  };
}

// ============================================================================
// Tool Implementations
// ============================================================================

function reportToCto(args: ReportToCtoArgs): ReportToCtoResult {
  const db = getDb();

  // Run cleanup first
  runCleanup();

  // Rate limit: max 5 untriaged reports per agent
  const pendingFromAgent = db.prepare(
    "SELECT COUNT(*) as count FROM reports WHERE reporting_agent = ? AND triage_status = 'pending'"
  ).get(args.reporting_agent) as { count: number };
  if (pendingFromAgent.count >= 5) {
    return {
      id: '',
      message: `Too many untriaged reports from ${args.reporting_agent} (max 5). Wait for existing reports to be triaged.`,
    };
  }

  const id = randomUUID();
  const now = new Date();
  const created_at = now.toISOString();
  const created_timestamp = Math.floor(now.getTime() / 1000);

  db.prepare(`
    INSERT INTO reports (id, reporting_agent, title, summary, category, priority, created_at, created_timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, args.reporting_agent, args.title, args.summary, args.category ?? 'other', args.priority ?? 'normal', created_at, created_timestamp);

  return {
    id,
    message: `Report submitted for triage. ID: ${id}`,
  };
}

function listReports(args: ListReportsArgs): ListReportsResult {
  const db = getDb();

  // Run cleanup first
  runCleanup();

  let sql = 'SELECT id, reporting_agent, title, category, priority, created_at, read_at, acknowledged_at, triage_status, triage_outcome, triaged_at, triage_action FROM reports';
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (args.unread_only) {
    conditions.push('read_at IS NULL');
  }

  if (args.untriaged_only) {
    // Use new triage_status field - pending means not triaged
    conditions.push("triage_status = 'pending'");
  }

  if (conditions.length > 0) {
    sql += ` WHERE ${  conditions.join(' AND ')}`;
  }

  sql += ' ORDER BY created_timestamp DESC LIMIT ?';
  params.push(args.limit ?? 20);

  const reports = db.prepare(sql).all(...params) as ReportRecord[];

  // Get counts
  interface CountResult { count: number }
  const unreadCount = (db.prepare('SELECT COUNT(*) as count FROM reports WHERE read_at IS NULL').get() as CountResult).count;
  const untriagedCount = (db.prepare("SELECT COUNT(*) as count FROM reports WHERE triage_status = 'pending'").get() as CountResult).count;

  const items: ReportListItem[] = reports.map(r => ({
    id: r.id,
    reporting_agent: r.reporting_agent,
    title: r.title,
    category: r.category,
    priority: r.priority,
    created_at: r.created_at,
    is_read: r.read_at !== null,
    is_acknowledged: r.acknowledged_at !== null,
    triage_status: (r.triage_status || 'pending') as TriageStatus,
    triage_outcome: r.triage_outcome,
    // Legacy fields
    is_triaged: r.triage_status !== 'pending',
    triage_action: r.triage_action as TriageAction | null,
  }));

  return {
    reports: items,
    total: items.length,
    unread_count: unreadCount,
    untriaged_count: untriagedCount,
  };
}

function readReport(args: ReadReportArgs): ReadReportResult | ErrorResult {
  const db = getDb();
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(args.id) as ReportRecord | undefined;

  if (!report) {
    return { error: `Report not found: ${args.id}` };
  }

  // Mark as read
  const now = new Date().toISOString();
  if (!report.read_at) {
    db.prepare('UPDATE reports SET read_at = ? WHERE id = ?').run(now, args.id);
  }

  return {
    id: report.id,
    reporting_agent: report.reporting_agent,
    title: report.title,
    summary: report.summary,
    category: report.category,
    priority: report.priority,
    created_at: report.created_at,
    read_at: report.read_at ?? now,
  };
}

function acknowledgeReport(args: AcknowledgeReportArgs): AcknowledgeReportResult | ErrorResult {
  const db = getDb();
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(args.id) as ReportRecord | undefined;

  if (!report) {
    return { error: `Report not found: ${args.id}` };
  }

  // Must read before acknowledging
  if (!report.read_at) {
    return {
      error: `Cannot acknowledge report ${args.id} without reading it first. Use read_report to view the full content before acknowledging.`,
    };
  }

  if (report.acknowledged_at) {
    return {
      id: args.id,
      acknowledged: true,
      message: `Report already acknowledged at ${report.acknowledged_at}`,
    };
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE reports SET acknowledged_at = ? WHERE id = ?').run(now, args.id);

  return {
    id: args.id,
    acknowledged: true,
    message: `Report acknowledged. Consider using deputy-cto MCP to add noteworthy items to the CTO question queue.`,
  };
}

function getUntriagedCount(_args: GetUntriagedCountArgs): GetUntriagedCountResult {
  const db = getDb();

  interface CountResult { count: number }
  interface PriorityCount { priority: string; count: number }

  // Use new triage_status field - pending means not triaged
  const total = (db.prepare("SELECT COUNT(*) as count FROM reports WHERE triage_status = 'pending'").get() as CountResult).count;

  const byPriority = db.prepare(`
    SELECT priority, COUNT(*) as count
    FROM reports
    WHERE triage_status = 'pending'
    GROUP BY priority
  `).all() as PriorityCount[];

  const priorityCounts = {
    critical: 0,
    high: 0,
    normal: 0,
    low: 0,
  };

  for (const row of byPriority) {
    if (row.priority in priorityCounts) {
      priorityCounts[row.priority as keyof typeof priorityCounts] = row.count;
    }
  }

  return {
    untriaged_count: total,
    by_priority: priorityCounts,
  };
}

function markTriaged(args: MarkTriagedArgs): MarkTriagedResult | ErrorResult {
  const db = getDb();
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(args.id) as ReportRecord | undefined;

  if (!report) {
    return { error: `Report not found: ${args.id}` };
  }

  if (report.triaged_at) {
    return {
      id: args.id,
      action: report.triage_action as TriageAction,
      message: `Report already triaged at ${report.triaged_at} with action: ${report.triage_action}`,
    };
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE reports SET triaged_at = ?, triage_action = ? WHERE id = ?').run(now, args.action, args.id);

  // If auto-acknowledged, also set acknowledged_at and read_at
  if (args.action === 'auto-acknowledged') {
    db.prepare('UPDATE reports SET read_at = COALESCE(read_at, ?), acknowledged_at = COALESCE(acknowledged_at, ?) WHERE id = ?').run(now, now, args.id);
  }

  return {
    id: args.id,
    action: args.action,
    message: `Report triaged with action: ${args.action}`,
  };
}

// ============================================================================
// New Triage Lifecycle Tools
// ============================================================================

function startTriage(args: StartTriageArgs): StartTriageResult | ErrorResult {
  const db = getDb();
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(args.id) as ReportRecord | undefined;

  if (!report) {
    return { error: `Report not found: ${args.id}` };
  }

  if (report.triage_status === 'in_progress') {
    return {
      id: args.id,
      started: false,
      message: `Report already being triaged (started at ${report.triage_started_at})`,
    };
  }

  if (report.triage_status !== 'pending') {
    return {
      id: args.id,
      started: false,
      message: `Report already triaged with status: ${report.triage_status}`,
    };
  }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE reports
    SET triage_status = 'in_progress', triage_started_at = ?, triage_session_id = ?,
        triage_attempted_at = ?, read_at = COALESCE(read_at, ?)
    WHERE id = ?
  `).run(now, args.session_id || null, now, now, args.id);

  return {
    id: args.id,
    started: true,
    message: `Triage started for report: ${report.title}`,
  };
}

function completeTriage(args: CompleteTriageArgs): CompleteTriageResult | ErrorResult {
  const db = getDb();
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(args.id) as ReportRecord | undefined;

  if (!report) {
    return { error: `Report not found: ${args.id}` };
  }

  if (report.triage_status !== 'in_progress' && report.triage_status !== 'pending') {
    return { error: `Report already completed with status: ${report.triage_status}` };
  }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE reports
    SET triage_status = ?, triage_completed_at = ?, triage_outcome = ?,
        triaged_at = ?, triage_action = ?,
        acknowledged_at = COALESCE(acknowledged_at, ?)
    WHERE id = ?
  `).run(args.status, now, args.outcome, now, args.status, now, args.id);

  return {
    id: args.id,
    status: args.status,
    outcome: args.outcome,
    message: `Triage completed: ${args.status}`,
  };
}

function getTriageStats(args: GetTriageStatsArgs): GetTriageStatsResult {
  const db = getDb();

  interface CountResult { count: number }

  const now = Date.now();
  const recentCutoff = new Date(now - (args.recent_window_hours ?? 24) * 60 * 60 * 1000).toISOString();
  const extendedCutoff = new Date(now - (args.extended_window_hours ?? 168) * 60 * 60 * 1000).toISOString();

  // Current status counts
  const pending = (db.prepare("SELECT COUNT(*) as count FROM reports WHERE triage_status = 'pending'").get() as CountResult).count;
  const inProgress = (db.prepare("SELECT COUNT(*) as count FROM reports WHERE triage_status = 'in_progress'").get() as CountResult).count;

  // Completed counts by time range (recent = default 24h, extended = default 7d)
  const selfHandledRecent = (db.prepare(`
    SELECT COUNT(*) as count FROM reports
    WHERE triage_status = 'self_handled' AND triage_completed_at >= ?
  `).get(recentCutoff) as CountResult).count;

  const selfHandledExtended = (db.prepare(`
    SELECT COUNT(*) as count FROM reports
    WHERE triage_status = 'self_handled' AND triage_completed_at >= ?
  `).get(extendedCutoff) as CountResult).count;

  const escalatedRecent = (db.prepare(`
    SELECT COUNT(*) as count FROM reports
    WHERE triage_status = 'escalated' AND triage_completed_at >= ?
  `).get(recentCutoff) as CountResult).count;

  const escalatedExtended = (db.prepare(`
    SELECT COUNT(*) as count FROM reports
    WHERE triage_status = 'escalated' AND triage_completed_at >= ?
  `).get(extendedCutoff) as CountResult).count;

  const dismissedRecent = (db.prepare(`
    SELECT COUNT(*) as count FROM reports
    WHERE triage_status = 'dismissed' AND triage_completed_at >= ?
  `).get(recentCutoff) as CountResult).count;

  const dismissedExtended = (db.prepare(`
    SELECT COUNT(*) as count FROM reports
    WHERE triage_status = 'dismissed' AND triage_completed_at >= ?
  `).get(extendedCutoff) as CountResult).count;

  return {
    stats: {
      pending,
      in_progress: inProgress,
      self_handled_24h: selfHandledRecent,
      self_handled_7d: selfHandledExtended,
      escalated_24h: escalatedRecent,
      escalated_7d: escalatedExtended,
      dismissed_24h: dismissedRecent,
      dismissed_7d: dismissedExtended,
    },
    message: `Triage stats: ${pending} pending, ${inProgress} in progress, ${selfHandledRecent}/${selfHandledExtended} self-handled (recent/extended), ${escalatedRecent}/${escalatedExtended} escalated (recent/extended), ${dismissedRecent}/${dismissedExtended} dismissed (recent/extended)`,
  };
}

// Cooldown: 1 hour between triage attempts on same report
const TRIAGE_COOLDOWN_MS = 60 * 60 * 1000;

function getReportsForTriage(args: GetReportsForTriageArgs): GetReportsForTriageResult {
  const db = getDb();
  const now = new Date();
  const cooldownCutoff = new Date(now.getTime() - TRIAGE_COOLDOWN_MS).toISOString();

  // First, reset stale in_progress reports (started > 1 hour ago) back to pending
  // This handles cases where triage was started but never completed (timeout, crash, etc.)
  db.prepare(`
    UPDATE reports
    SET triage_status = 'pending'
    WHERE triage_status = 'in_progress'
      AND triage_started_at < ?
  `).run(cooldownCutoff);

  // Get reports that are:
  // 1. Status = pending
  // 2. Either never attempted, or last attempt was > 1 hour ago
  const reports = db.prepare(`
    SELECT id, reporting_agent, title, summary, category, priority, created_at
    FROM reports
    WHERE triage_status = 'pending'
      AND (triage_attempted_at IS NULL OR triage_attempted_at < ?)
    ORDER BY
      CASE priority
        WHEN 'critical' THEN 1
        WHEN 'high' THEN 2
        WHEN 'normal' THEN 3
        WHEN 'low' THEN 4
      END,
      created_timestamp ASC
    LIMIT ?
  `).all(cooldownCutoff, args.limit ?? 10) as {
    id: string;
    reporting_agent: string;
    title: string;
    summary: string;
    category: string;
    priority: string;
    created_at: string;
  }[];

  interface CountResult { count: number }
  // Total pending (regardless of cooldown)
  const totalPending = (db.prepare("SELECT COUNT(*) as count FROM reports WHERE triage_status = 'pending'").get() as CountResult).count;
  // Ready for triage (past cooldown)
  const totalReady = (db.prepare(`
    SELECT COUNT(*) as count FROM reports
    WHERE triage_status = 'pending'
      AND (triage_attempted_at IS NULL OR triage_attempted_at < ?)
  `).get(cooldownCutoff) as CountResult).count;

  return {
    reports: reports.map(r => ({
      id: r.id,
      reporting_agent: r.reporting_agent,
      title: r.title,
      summary: r.summary,
      category: r.category as import('./types.js').ReportCategory,
      priority: r.priority,
      created_at: r.created_at,
    })),
    total: totalReady,
    message: `Found ${reports.length} of ${totalReady} reports ready for triage (${totalPending} total pending, ${totalPending - totalReady} on cooldown)`,
  };
}

// ============================================================================
// Server Setup
// ============================================================================

const tools: AnyToolHandler[] = [
  {
    name: 'report_to_deputy_cto',
    description: 'Report an issue to the deputy-cto for triage. Deputy-cto reviews and may escalate to CTO queue. Use for architecture decisions, security concerns, blockers, or important changes.',
    schema: ReportToCtoArgsSchema,
    handler: reportToCto,
  },
  {
    name: 'list_reports',
    description: 'List CTO reports (titles and timestamps only to preserve tokens). Use unread_only=true for unread, untriaged_only=true for reports needing deputy-cto triage.',
    schema: ListReportsArgsSchema,
    handler: listReports,
  },
  {
    name: 'read_report',
    description: 'Read the full content of a report. Marks the report as read. Required before acknowledging.',
    schema: ReadReportArgsSchema,
    handler: readReport,
  },
  {
    name: 'acknowledge_report',
    description: 'Acknowledge a report (must read first). After acknowledging, consider adding noteworthy items to CTO question queue via deputy-cto MCP.',
    schema: AcknowledgeReportArgsSchema,
    handler: acknowledgeReport,
  },
  {
    name: 'get_untriaged_count',
    description: 'Get count of reports not yet triaged by deputy-cto. Used to check if triage is needed before /deputy-cto session.',
    schema: GetUntriagedCountArgsSchema,
    handler: getUntriagedCount,
  },
  {
    name: 'mark_triaged',
    description: 'Mark a report as triaged by deputy-cto. Actions: auto-acknowledged (routine/clear), escalated (added to CTO queue), needs-cto-review (left for manual review).',
    schema: MarkTriagedArgsSchema,
    handler: markTriaged,
  },
  // New triage lifecycle tools
  {
    name: 'start_triage',
    description: 'Start triaging a report. Sets status to in_progress. Call this before investigating a report.',
    schema: StartTriageArgsSchema,
    handler: startTriage,
  },
  {
    name: 'complete_triage',
    description: 'Complete triage of a report. Status: self_handled (spawned task to fix), escalated (added to CTO queue), or dismissed (not a real issue/already resolved). Include outcome description.',
    schema: CompleteTriageArgsSchema,
    handler: completeTriage,
  },
  {
    name: 'get_triage_stats',
    description: 'Get triage statistics: pending, in_progress, self_handled (24h/7d), escalated (24h/7d). Used for CTO reporting.',
    schema: GetTriageStatsArgsSchema,
    handler: getTriageStats,
  },
  {
    name: 'get_reports_for_triage',
    description: 'Get pending reports ready for triage, ordered by priority (critical first). Includes full summary for investigation.',
    schema: GetReportsForTriageArgsSchema,
    handler: getReportsForTriage,
  },
];

const server = new McpServer({
  name: 'agent-reports',
  version: '2.0.0',
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
