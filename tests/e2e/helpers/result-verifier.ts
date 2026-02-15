/**
 * Result Verifier for E2E Tests
 *
 * Opens the database files created during a real Claude feedback session
 * and returns structured results for assertions.
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';

export interface FindingResult {
  id: string;
  title: string;
  category: string;
  severity: string;
  description: string;
  created_at: string;
}

export interface SummaryResult {
  overall_impression: string;
  areas_tested: string[];
  confidence: string;
  summary_notes: string | null;
}

export interface ReportResult {
  id: string;
  reporting_agent: string;
  title: string;
  summary: string;
  category: string;
  priority: string;
  triage_status: string;
}

export interface AuditEventResult {
  id: string;
  session_id: string;
  event_type: string;
  event_category: string;
  input: string;
  output: string | null;
  error: string | null;
  duration_ms: number;
  metadata: string;
}

export interface SessionResults {
  findings: FindingResult[];
  summary: SummaryResult | null;
  reports: ReportResult[];
  auditEvents: AuditEventResult[];
}

/**
 * Read results from all databases for a given feedback session.
 */
export function getSessionResults(
  projectDir: string,
  sessionId: string,
  personaName: string
): SessionResults {
  const claudeDir = path.join(projectDir, '.claude');
  const results: SessionResults = {
    findings: [],
    summary: null,
    reports: [],
    auditEvents: [],
  };

  // Read findings from session DB
  const sessionDbPath = path.join(claudeDir, 'feedback-sessions', `${sessionId}.db`);
  if (fs.existsSync(sessionDbPath)) {
    const sessionDb = new Database(sessionDbPath, { readonly: true });

    try {
      results.findings = sessionDb.prepare(
        'SELECT id, title, category, severity, description, created_at FROM findings ORDER BY created_at'
      ).all() as FindingResult[];
    } catch {
      // Table may not exist if session had no findings
    }

    try {
      interface SummaryRow {
        overall_impression: string;
        areas_tested: string;
        confidence: string;
        summary_notes: string | null;
      }
      const summaryRow = sessionDb.prepare(
        'SELECT overall_impression, areas_tested, confidence, summary_notes FROM session_summary WHERE id = ?'
      ).get('summary') as SummaryRow | undefined;

      if (summaryRow) {
        results.summary = {
          overall_impression: summaryRow.overall_impression,
          areas_tested: JSON.parse(summaryRow.areas_tested) as string[],
          confidence: summaryRow.confidence,
          summary_notes: summaryRow.summary_notes,
        };
      }
    } catch {
      // Table may not exist
    }

    sessionDb.close();
  }

  // Read reports from agent-reports DB
  const reportsDbPath = path.join(claudeDir, 'cto-reports.db');
  if (fs.existsSync(reportsDbPath)) {
    const reportsDb = new Database(reportsDbPath, { readonly: true });

    try {
      const reportingAgent = `feedback-${personaName}`;
      results.reports = reportsDb.prepare(
        'SELECT id, reporting_agent, title, summary, category, priority, triage_status FROM reports WHERE reporting_agent = ? ORDER BY created_at'
      ).all(reportingAgent) as ReportResult[];
    } catch {
      // Table may not exist
    }

    reportsDb.close();
  }

  // Read audit events from session-events DB
  const eventsDbPath = path.join(claudeDir, 'session-events.db');
  if (fs.existsSync(eventsDbPath)) {
    const eventsDb = new Database(eventsDbPath, { readonly: true });

    try {
      results.auditEvents = eventsDb.prepare(
        'SELECT id, session_id, event_type, event_category, input, output, error, duration_ms, metadata FROM session_events WHERE session_id = ? ORDER BY timestamp'
      ).all(sessionId) as AuditEventResult[];
    } catch {
      // Table may not exist
    }

    eventsDb.close();
  }

  return results;
}
