/**
 * Feedback Agent Stub for Integration Tests
 *
 * Simulates a feedback agent session by directly calling
 * feedback-reporter functions with canned findings.
 *
 * This stub is used in integration tests to verify the full feedback pipeline
 * WITHOUT spawning real Claude sessions.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface StubFinding {
  title: string;
  category: 'usability' | 'functionality' | 'performance' | 'accessibility' | 'visual' | 'content' | 'security' | 'other';
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  description: string;
  steps_to_reproduce?: string[];
  expected_behavior?: string;
  actual_behavior?: string;
  url?: string;
}

export interface StubSummary {
  overall_impression: 'positive' | 'neutral' | 'negative' | 'unusable';
  areas_tested: string[];
  areas_not_tested?: string[];
  confidence: 'high' | 'medium' | 'low';
  summary_notes?: string;
}

/**
 * Maps finding severity to report priority.
 */
function severityToPriority(severity: StubFinding['severity']): 'low' | 'normal' | 'high' | 'critical' {
  switch (severity) {
    case 'critical': return 'critical';
    case 'high': return 'high';
    case 'medium': return 'normal';
    case 'low': return 'low';
    case 'info': return 'low';
  }
}

/**
 * Maps overall impression to report priority.
 */
function impressionToPriority(impression: StubSummary['overall_impression']): 'low' | 'normal' | 'high' | 'critical' {
  switch (impression) {
    case 'unusable': return 'critical';
    case 'negative': return 'high';
    case 'neutral': return 'normal';
    case 'positive': return 'low';
  }
}

/**
 * Simulates submitting a finding through the feedback-reporter pipeline.
 * Directly inserts into session and reports databases.
 */
function submitFinding(
  sessionDb: Database.Database,
  reportsDb: Database.Database,
  personaName: string,
  finding: StubFinding
): { findingId: string; reportId: string } {
  const findingId = randomUUID();
  const reportId = randomUUID();
  const now = new Date();
  const created_at = now.toISOString();
  const created_timestamp = Math.floor(now.getTime() / 1000);

  // 1. Store finding in session DB
  sessionDb.prepare(`
    INSERT INTO findings (id, title, category, severity, description, steps_to_reproduce, expected_behavior, actual_behavior, screenshot_ref, url, report_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    findingId,
    finding.title,
    finding.category,
    finding.severity,
    finding.description,
    JSON.stringify(finding.steps_to_reproduce ?? []),
    finding.expected_behavior ?? null,
    finding.actual_behavior ?? null,
    null, // screenshot_ref
    finding.url ?? null,
    reportId,
    created_at
  );

  // 2. Build summary for agent-reports
  let summary = finding.description;

  if (finding.steps_to_reproduce && finding.steps_to_reproduce.length > 0) {
    summary += '\n\nSteps to reproduce:\n' + finding.steps_to_reproduce.map((step, i) => `${i + 1}. ${step}`).join('\n');
  }

  if (finding.expected_behavior) {
    summary += `\n\nExpected: ${finding.expected_behavior}`;
  }

  if (finding.actual_behavior) {
    summary += `\n\nActual: ${finding.actual_behavior}`;
  }

  if (finding.url) {
    summary += `\n\nURL: ${finding.url}`;
  }

  // 3. Submit to agent-reports DB
  const priority = severityToPriority(finding.severity);
  const reportingAgent = `feedback-${personaName}`;

  reportsDb.prepare(`
    INSERT INTO reports (id, reporting_agent, title, summary, category, priority, created_at, created_timestamp, triage_status)
    VALUES (?, ?, ?, ?, 'user-feedback', ?, ?, ?, 'pending')
  `).run(
    reportId,
    reportingAgent,
    finding.title,
    summary,
    priority,
    created_at,
    created_timestamp
  );

  return { findingId, reportId };
}

/**
 * Simulates submitting a session summary through the feedback-reporter pipeline.
 * Directly inserts into session and reports databases.
 */
function submitSummary(
  sessionDb: Database.Database,
  reportsDb: Database.Database,
  personaName: string,
  summary: StubSummary
): { summaryId: string; reportId: string } {
  const summaryId = 'summary';
  const reportId = randomUUID();
  const now = new Date();
  const created_at = now.toISOString();
  const created_timestamp = Math.floor(now.getTime() / 1000);

  // 1. Store summary in session DB
  sessionDb.prepare(`
    INSERT OR REPLACE INTO session_summary (id, overall_impression, areas_tested, areas_not_tested, confidence, summary_notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    summaryId,
    summary.overall_impression,
    JSON.stringify(summary.areas_tested),
    JSON.stringify(summary.areas_not_tested ?? []),
    summary.confidence,
    summary.summary_notes ?? null,
    created_at
  );

  // 2. Build report summary
  let reportSummary = `Testing session completed with ${summary.overall_impression} impression (confidence: ${summary.confidence}).\n\n`;
  reportSummary += `Areas tested:\n${summary.areas_tested.map(a => `- ${a}`).join('\n')}`;

  if (summary.areas_not_tested && summary.areas_not_tested.length > 0) {
    reportSummary += `\n\nAreas NOT tested:\n${summary.areas_not_tested.map(a => `- ${a}`).join('\n')}`;
  }

  if (summary.summary_notes) {
    reportSummary += `\n\nNotes:\n${summary.summary_notes}`;
  }

  // 3. Submit to agent-reports DB
  const priority = impressionToPriority(summary.overall_impression);
  const reportingAgent = `feedback-${personaName}`;

  reportsDb.prepare(`
    INSERT INTO reports (id, reporting_agent, title, summary, category, priority, created_at, created_timestamp, triage_status)
    VALUES (?, ?, ?, ?, 'user-feedback', ?, ?, ?, 'pending')
  `).run(
    reportId,
    reportingAgent,
    `Feedback Session Summary - ${personaName}`,
    reportSummary,
    priority,
    created_at,
    created_timestamp
  );

  return { summaryId, reportId };
}

/**
 * Simulates a complete feedback session by:
 * 1. Creating a session database with findings schema
 * 2. Submitting all findings
 * 3. Submitting a summary
 * 4. Returning IDs for verification
 */
export function simulateFeedbackSession(
  sessionDb: Database.Database,
  reportsDb: Database.Database,
  personaName: string,
  findings: StubFinding[],
  summary?: StubSummary
): { findingIds: string[]; reportIds: string[] } {
  const findingIds: string[] = [];
  const reportIds: string[] = [];

  // Initialize session DB schema
  sessionDb.exec(`
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
  `);

  // Submit findings
  for (const finding of findings) {
    const { findingId, reportId } = submitFinding(sessionDb, reportsDb, personaName, finding);
    findingIds.push(findingId);
    reportIds.push(reportId);
  }

  // Submit summary if provided
  if (summary) {
    const { reportId } = submitSummary(sessionDb, reportsDb, personaName, summary);
    reportIds.push(reportId);
  }

  return { findingIds, reportIds };
}
