#!/usr/bin/env node
/**
 * Feedback Reporter MCP Server
 *
 * Enables isolated feedback agents to submit structured findings and session summaries.
 * Bridges to the agent-reports pipeline for deputy-CTO triage.
 *
 * Environment Variables:
 * - FEEDBACK_PERSONA_NAME: Name of the persona running this session (e.g., "power-user")
 * - FEEDBACK_SESSION_ID: UUID of the feedback session (from user-feedback MCP)
 * - CLAUDE_PROJECT_DIR: Project directory (F001 compliance)
 *
 * Flow:
 * 1. Feedback agent calls submit_finding or submit_summary
 * 2. Finding/summary stored in local session DB (PROJECT_DIR/.claude/feedback-sessions/{session_id}.db)
 * 3. Report forwarded to agent-reports DB (PROJECT_DIR/.claude/cto-reports.db)
 * 4. Deputy-CTO triages reports via agent-reports MCP server
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (stdio MCP)
 *
 * @version 1.0.0
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { type AnyToolHandler } from '../shared/server.js';
import { AuditedMcpServer } from '../shared/audited-server.js';
import {
  SubmitFindingArgsSchema,
  SubmitSummaryArgsSchema,
  ListFindingsArgsSchema,
  type SubmitFindingArgs,
  type SubmitSummaryArgs,
  type ListFindingsArgs,
  type FindingRecord,
  type FindingResult,
  type SubmitFindingResult,
  type SubmitSummaryResult,
  type ListFindingsResult,
  type ErrorResult,
  type FindingSeverity,
  type OverallImpression,
} from './types.js';

// ============================================================================
// Configuration Interface
// ============================================================================

export interface FeedbackReporterConfig {
  personaName: string;
  sessionId: string;
  projectDir: string;
  // Testing overrides: provide pre-created DBs instead of file paths
  sessionDb?: Database.Database;
  reportsDb?: Database.Database;
  auditSessionId?: string;    // defaults to config.sessionId
  auditPersonaName?: string;  // defaults to config.personaName
  auditDbPath?: string;
}

// ============================================================================
// Database Schemas
// ============================================================================

const SESSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS findings (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    severity TEXT NOT NULL,
    description TEXT NOT NULL,
    steps_to_reproduce TEXT DEFAULT '[]',
    expected_behavior TEXT,
    actual_behavior TEXT,
    screenshot_ref TEXT,
    url TEXT,
    report_id TEXT,
    created_at TEXT NOT NULL,
    CONSTRAINT valid_category CHECK (category IN ('usability', 'functionality', 'performance', 'accessibility', 'visual', 'content', 'security', 'other')),
    CONSTRAINT valid_severity CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info'))
);

CREATE TABLE IF NOT EXISTS session_summary (
    id TEXT PRIMARY KEY DEFAULT 'summary',
    overall_impression TEXT NOT NULL,
    areas_tested TEXT NOT NULL DEFAULT '[]',
    areas_not_tested TEXT NOT NULL DEFAULT '[]',
    confidence TEXT NOT NULL,
    summary_notes TEXT,
    created_at TEXT NOT NULL,
    CONSTRAINT valid_impression CHECK (overall_impression IN ('positive', 'neutral', 'negative', 'unusable')),
    CONSTRAINT valid_confidence CHECK (confidence IN ('high', 'medium', 'low'))
);
`;

const REPORTS_SCHEMA = `
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
    triage_status TEXT NOT NULL DEFAULT 'pending',
    triage_started_at TEXT,
    triage_completed_at TEXT,
    triage_session_id TEXT,
    triage_outcome TEXT,
    triage_attempted_at TEXT,
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
// Severity to Priority Mapping (Pure Functions - Module Level)
// ============================================================================

function severityToPriority(severity: FindingSeverity): 'low' | 'normal' | 'high' | 'critical' {
  switch (severity) {
    case 'critical': return 'critical';
    case 'high': return 'high';
    case 'medium': return 'normal';
    case 'low': return 'low';
    case 'info': return 'low';
  }
}

function impressionToPriority(impression: OverallImpression): 'low' | 'normal' | 'high' | 'critical' {
  switch (impression) {
    case 'unusable': return 'critical';
    case 'negative': return 'high';
    case 'neutral': return 'normal';
    case 'positive': return 'low';
  }
}

// ============================================================================
// Helper: Record to Result Conversion (Pure Function - Module Level)
// ============================================================================

function findingToResult(record: FindingRecord): FindingResult {
  const result: FindingResult = {
    id: record.id,
    title: record.title,
    category: record.category,
    severity: record.severity,
    description: record.description,
    created_at: record.created_at,
  };

  const stepsToReproduce = JSON.parse(record.steps_to_reproduce) as string[];
  if (stepsToReproduce.length > 0) {
    result.steps_to_reproduce = stepsToReproduce;
  }

  if (record.expected_behavior) {
    result.expected_behavior = record.expected_behavior;
  }

  if (record.actual_behavior) {
    result.actual_behavior = record.actual_behavior;
  }

  if (record.screenshot_ref) {
    result.screenshot_ref = record.screenshot_ref;
  }

  if (record.url) {
    result.url = record.url;
  }

  if (record.report_id) {
    result.report_id = record.report_id;
  }

  return result;
}

// ============================================================================
// Server Factory Function
// ============================================================================

export function createFeedbackReporterServer(config: FeedbackReporterConfig): AuditedMcpServer {
  // ============================================================================
  // Database Management (Factory-scoped)
  // ============================================================================

  let _sessionDb: Database.Database | null = null;
  let _reportsDb: Database.Database | null = null;

  function initializeSessionDb(): Database.Database {
    const sessionsDir = path.join(config.projectDir, '.claude', 'feedback-sessions');
    const sessionDbPath = path.join(sessionsDir, `${config.sessionId}.db`);

    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true });
    }

    const db = new Database(sessionDbPath);
    db.pragma('journal_mode = WAL');
    db.exec(SESSION_SCHEMA);
    return db;
  }

  function initializeReportsDb(): Database.Database {
    const reportsDbPath = path.join(config.projectDir, '.claude', 'cto-reports.db');
    const dbDir = path.dirname(reportsDbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    const db = new Database(reportsDbPath);
    db.pragma('journal_mode = WAL');
    db.exec(REPORTS_SCHEMA);
    return db;
  }

  function getSessionDb(): Database.Database {
    if (!_sessionDb) {
      _sessionDb = config.sessionDb ?? initializeSessionDb();
    }
    return _sessionDb;
  }

  function getReportsDb(): Database.Database {
    if (!_reportsDb) {
      _reportsDb = config.reportsDb ?? initializeReportsDb();
    }
    return _reportsDb;
  }

  function closeDbs(): void {
    // Only close DBs we created, not ones provided via config
    if (_sessionDb && !config.sessionDb) {
      _sessionDb.close();
      _sessionDb = null;
    }
    if (_reportsDb && !config.reportsDb) {
      _reportsDb.close();
      _reportsDb = null;
    }
  }

  // ============================================================================
  // Tool Handlers (Factory-scoped)
  // ============================================================================

  function submitFinding(args: SubmitFindingArgs): SubmitFindingResult | ErrorResult {
    const sessionDb = getSessionDb();
    const reportsDb = getReportsDb();

    const findingId = randomUUID();
    const reportId = randomUUID();
    const now = new Date();
    const created_at = now.toISOString();
    const created_timestamp = Math.floor(now.getTime() / 1000);

    try {
      // 1. Store finding in local session DB
      sessionDb.prepare(`
        INSERT INTO findings (id, title, category, severity, description, steps_to_reproduce, expected_behavior, actual_behavior, screenshot_ref, url, report_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        findingId,
        args.title,
        args.category,
        args.severity,
        args.description,
        JSON.stringify(args.steps_to_reproduce ?? []),
        args.expected_behavior ?? null,
        args.actual_behavior ?? null,
        args.screenshot_ref ?? null,
        args.url ?? null,
        reportId,
        created_at,
      );

      // 2. Build summary for agent-reports
      let summary = args.description;

      if (args.steps_to_reproduce && args.steps_to_reproduce.length > 0) {
        summary += '\n\nSteps to reproduce:\n' + args.steps_to_reproduce.map((step, i) => `${i + 1}. ${step}`).join('\n');
      }

      if (args.expected_behavior) {
        summary += `\n\nExpected: ${args.expected_behavior}`;
      }

      if (args.actual_behavior) {
        summary += `\n\nActual: ${args.actual_behavior}`;
      }

      if (args.url) {
        summary += `\n\nURL: ${args.url}`;
      }

      if (args.screenshot_ref) {
        summary += `\n\nScreenshot: ${args.screenshot_ref}`;
      }

      // 3. Submit to agent-reports DB
      const priority = severityToPriority(args.severity);
      const reportingAgent = `feedback-${config.personaName}`;

      reportsDb.prepare(`
        INSERT INTO reports (id, reporting_agent, title, summary, category, priority, created_at, created_timestamp, triage_status)
        VALUES (?, ?, ?, ?, 'user-feedback', ?, ?, ?, 'pending')
      `).run(
        reportId,
        reportingAgent,
        args.title,
        summary,
        priority,
        created_at,
        created_timestamp,
      );

      return {
        id: findingId,
        report_id: reportId,
        message: `Finding submitted (severity: ${args.severity}, priority: ${priority}). Report ${reportId} created in agent-reports queue.`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to submit finding: ${message}` };
    }
  }

  function submitSummary(args: SubmitSummaryArgs): SubmitSummaryResult | ErrorResult {
    const sessionDb = getSessionDb();
    const reportsDb = getReportsDb();

    const summaryId = 'summary';
    const reportId = randomUUID();
    const now = new Date();
    const created_at = now.toISOString();
    const created_timestamp = Math.floor(now.getTime() / 1000);

    try {
      // 1. Store summary in local session DB
      sessionDb.prepare(`
        INSERT OR REPLACE INTO session_summary (id, overall_impression, areas_tested, areas_not_tested, confidence, summary_notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        summaryId,
        args.overall_impression,
        JSON.stringify(args.areas_tested),
        JSON.stringify(args.areas_not_tested ?? []),
        args.confidence,
        args.summary_notes ?? null,
        created_at,
      );

      // 2. Build summary for agent-reports
      const title = `Feedback Summary: ${config.personaName} - ${args.overall_impression}`;

      let summary = `Overall Impression: ${args.overall_impression}\nConfidence: ${args.confidence}\n\n`;

      summary += `Areas Tested (${args.areas_tested.length}):\n` + args.areas_tested.map(a => `- ${a}`).join('\n');

      if (args.areas_not_tested && args.areas_not_tested.length > 0) {
        summary += `\n\nAreas Not Tested (${args.areas_not_tested.length}):\n` + args.areas_not_tested.map(a => `- ${a}`).join('\n');
      }

      if (args.summary_notes) {
        summary += `\n\nNotes:\n${args.summary_notes}`;
      }

      summary += `\n\nSession ID: ${config.sessionId}`;

      // 3. Submit to agent-reports DB
      const priority = impressionToPriority(args.overall_impression);
      const reportingAgent = `feedback-${config.personaName}`;

      reportsDb.prepare(`
        INSERT INTO reports (id, reporting_agent, title, summary, category, priority, created_at, created_timestamp, triage_status)
        VALUES (?, ?, ?, ?, 'user-feedback', ?, ?, ?, 'pending')
      `).run(
        reportId,
        reportingAgent,
        title,
        summary,
        priority,
        created_at,
        created_timestamp,
      );

      return {
        id: summaryId,
        report_id: reportId,
        message: `Session summary submitted (impression: ${args.overall_impression}, priority: ${priority}). Report ${reportId} created in agent-reports queue.`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to submit summary: ${message}` };
    }
  }

  function listFindings(args: ListFindingsArgs): ListFindingsResult | ErrorResult {
    const sessionDb = getSessionDb();

    try {
      let sql = 'SELECT * FROM findings';
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (args.category) {
        conditions.push('category = ?');
        params.push(args.category);
      }

      if (args.severity) {
        conditions.push('severity = ?');
        params.push(args.severity);
      }

      if (conditions.length > 0) {
        sql += ` WHERE ${conditions.join(' AND ')}`;
      }

      sql += ' ORDER BY created_at DESC';

      const records = sessionDb.prepare(sql).all(...params) as FindingRecord[];

      return {
        findings: records.map(findingToResult),
        total: records.length,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to list findings: ${message}` };
    }
  }

  // ============================================================================
  // Server Setup (Factory-scoped)
  // ============================================================================

  const tools: AnyToolHandler[] = [
    {
      name: 'submit_finding',
      description: 'Submit a user feedback finding. Stores finding locally and creates a report in the agent-reports triage queue.',
      schema: SubmitFindingArgsSchema,
      handler: submitFinding,
    },
    {
      name: 'submit_summary',
      description: 'Submit a session summary. Stores summary locally and creates a summary report in the agent-reports triage queue.',
      schema: SubmitSummaryArgsSchema,
      handler: submitSummary,
    },
    {
      name: 'list_findings',
      description: 'List findings from this feedback session with optional category/severity filters.',
      schema: ListFindingsArgsSchema,
      handler: listFindings,
    },
  ];

  const server = new AuditedMcpServer({
    name: 'feedback-reporter',
    version: '1.0.0',
    tools,
    auditSessionId: config.auditSessionId ?? config.sessionId,
    auditPersonaName: config.auditPersonaName ?? config.personaName,
    auditDbPath: config.auditDbPath,
  });

  // Handle cleanup on exit
  process.on('SIGINT', () => {
    closeDbs();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    closeDbs();
    process.exit(0);
  });

  return server;
}

// ============================================================================
// Auto-start Guard (Module Entry Point)
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const personaName = process.env['FEEDBACK_PERSONA_NAME'];
  const sessionId = process.env['FEEDBACK_SESSION_ID'];
  const projectDir = path.resolve(process.env['CLAUDE_PROJECT_DIR'] || process.cwd());

  if (!personaName) {
    process.stderr.write('[feedback-reporter] ERROR: FEEDBACK_PERSONA_NAME environment variable is required\n');
    process.exit(1);
  }
  if (!sessionId) {
    process.stderr.write('[feedback-reporter] ERROR: FEEDBACK_SESSION_ID environment variable is required\n');
    process.exit(1);
  }

  const server = createFeedbackReporterServer({ personaName, sessionId, projectDir });
  server.start();
}
