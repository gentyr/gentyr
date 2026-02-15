/**
 * Tests for feedback-reporter MCP server
 *
 * Tests:
 * - Finding submission: stores locally + writes to agent-reports DB
 * - Finding deduplication: list_findings shows all submitted findings
 * - Severity-to-priority mapping
 * - Summary submission: stores + creates summary report
 * - Schema validation (missing required fields, invalid severity/category)
 * - Bridge integration: verify report appears in cto-reports.db with correct category and reporting_agent
 * - Session isolation: each session gets its own DB
 *
 * @module feedback-reporter/__tests__
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { createTestDb, isErrorResult } from '../../__testUtils__/index.js';
import { AGENT_REPORTS_SCHEMA } from '../../__testUtils__/schemas.js';
import {
  SubmitFindingArgsSchema,
  SubmitSummaryArgsSchema,
  ListFindingsArgsSchema,
  type SubmitFindingArgs,
  type SubmitSummaryArgs,
  type ListFindingsArgs,
  type FindingRecord,
  type SessionSummaryRecord,
  type SubmitFindingResult,
  type SubmitSummaryResult,
  type ListFindingsResult,
} from '../types.js';

// ============================================================================
// Database Schemas (matching server.ts)
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

// ============================================================================
// Test Implementation Functions (matching server.ts handlers)
// ============================================================================

interface ReportRecord {
  id: string;
  reporting_agent: string;
  title: string;
  summary: string;
  category: string;
  priority: string;
  created_at: string;
  created_timestamp: number;
  triage_status: string;
}

function severityToPriority(severity: string): 'low' | 'normal' | 'high' | 'critical' {
  switch (severity) {
    case 'critical': return 'critical';
    case 'high': return 'high';
    case 'medium': return 'normal';
    case 'low': return 'low';
    case 'info': return 'low';
    default: return 'normal';
  }
}

function impressionToPriority(impression: string): 'low' | 'normal' | 'high' | 'critical' {
  switch (impression) {
    case 'unusable': return 'critical';
    case 'negative': return 'high';
    case 'neutral': return 'normal';
    case 'positive': return 'low';
    default: return 'normal';
  }
}

function submitFinding(
  args: SubmitFindingArgs,
  sessionDb: Database.Database,
  reportsDb: Database.Database,
  personaName: string
): SubmitFindingResult {
  const findingId = randomUUID();
  const reportId = randomUUID();
  const now = new Date();
  const created_at = now.toISOString();
  const created_timestamp = Math.floor(now.getTime() / 1000);

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
  const reportingAgent = `feedback-${personaName}`;

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
}

function submitSummary(
  args: SubmitSummaryArgs,
  sessionDb: Database.Database,
  reportsDb: Database.Database,
  personaName: string,
  sessionId: string
): SubmitSummaryResult {
  const summaryId = 'summary';
  const reportId = randomUUID();
  const now = new Date();
  const created_at = now.toISOString();
  const created_timestamp = Math.floor(now.getTime() / 1000);

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
  const title = `Feedback Summary: ${personaName} - ${args.overall_impression}`;

  let summary = `Overall Impression: ${args.overall_impression}\nConfidence: ${args.confidence}\n\n`;

  summary += `Areas Tested (${args.areas_tested.length}):\n` + args.areas_tested.map(a => `- ${a}`).join('\n');

  if (args.areas_not_tested && args.areas_not_tested.length > 0) {
    summary += `\n\nAreas Not Tested (${args.areas_not_tested.length}):\n` + args.areas_not_tested.map(a => `- ${a}`).join('\n');
  }

  if (args.summary_notes) {
    summary += `\n\nNotes:\n${args.summary_notes}`;
  }

  summary += `\n\nSession ID: ${sessionId}`;

  // 3. Submit to agent-reports DB
  const priority = impressionToPriority(args.overall_impression);
  const reportingAgent = `feedback-${personaName}`;

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
}

function listFindings(args: ListFindingsArgs, sessionDb: Database.Database): ListFindingsResult {
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
    findings: records.map(r => ({
      id: r.id,
      title: r.title,
      category: r.category,
      severity: r.severity,
      description: r.description,
      steps_to_reproduce: JSON.parse(r.steps_to_reproduce) as string[],
      expected_behavior: r.expected_behavior ?? undefined,
      actual_behavior: r.actual_behavior ?? undefined,
      screenshot_ref: r.screenshot_ref ?? undefined,
      url: r.url ?? undefined,
      report_id: r.report_id ?? undefined,
      created_at: r.created_at,
    })),
    total: records.length,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('feedback-reporter MCP server', () => {
  let sessionDb: Database.Database;
  let reportsDb: Database.Database;
  const personaName = 'power-user';
  const sessionId = randomUUID();

  beforeEach(() => {
    sessionDb = createTestDb(SESSION_SCHEMA);
    reportsDb = createTestDb(AGENT_REPORTS_SCHEMA);
  });

  afterEach(() => {
    sessionDb.close();
    reportsDb.close();
  });

  describe('submit_finding', () => {
    it('should store finding locally and create report in agent-reports DB', () => {
      const args: SubmitFindingArgs = {
        title: 'Button does not respond',
        category: 'functionality',
        severity: 'high',
        description: 'The submit button on the checkout page does not respond to clicks.',
        steps_to_reproduce: [
          'Navigate to checkout page',
          'Fill in payment details',
          'Click submit button',
        ],
        expected_behavior: 'Form should submit and show confirmation',
        actual_behavior: 'Nothing happens when clicking submit',
        url: 'https://example.com/checkout',
      };

      const result = submitFinding(args, sessionDb, reportsDb, personaName);

      expect(result.id).toBeTruthy();
      expect(result.report_id).toBeTruthy();
      expect(result.message).toContain('severity: high');
      expect(result.message).toContain('priority: high');

      // Verify local storage
      const finding = sessionDb.prepare('SELECT * FROM findings WHERE id = ?').get(result.id) as FindingRecord;
      expect(finding).toBeTruthy();
      expect(finding.title).toBe(args.title);
      expect(finding.category).toBe(args.category);
      expect(finding.severity).toBe(args.severity);
      expect(finding.description).toBe(args.description);
      expect(finding.report_id).toBe(result.report_id);

      const stepsToReproduce = JSON.parse(finding.steps_to_reproduce) as string[];
      expect(stepsToReproduce).toEqual(args.steps_to_reproduce);
      expect(finding.expected_behavior).toBe(args.expected_behavior);
      expect(finding.actual_behavior).toBe(args.actual_behavior);
      expect(finding.url).toBe(args.url);

      // Verify agent-reports bridge
      const report = reportsDb.prepare('SELECT * FROM reports WHERE id = ?').get(result.report_id) as ReportRecord;
      expect(report).toBeTruthy();
      expect(report.reporting_agent).toBe('feedback-power-user');
      expect(report.title).toBe(args.title);
      expect(report.category).toBe('user-feedback');
      expect(report.priority).toBe('high');
      expect(report.triage_status).toBe('pending');
      expect(report.summary).toContain(args.description);
      expect(report.summary).toContain('Steps to reproduce:');
      expect(report.summary).toContain('Expected:');
      expect(report.summary).toContain('Actual:');
      expect(report.summary).toContain('URL:');
    });

    it('should map severity to priority correctly', () => {
      const testCases: Array<{ severity: 'critical' | 'high' | 'medium' | 'low' | 'info'; priority: string }> = [
        { severity: 'critical', priority: 'critical' },
        { severity: 'high', priority: 'high' },
        { severity: 'medium', priority: 'normal' },
        { severity: 'low', priority: 'low' },
        { severity: 'info', priority: 'low' },
      ];

      testCases.forEach(({ severity, priority }) => {
        const args: SubmitFindingArgs = {
          title: `Test finding - ${severity}`,
          category: 'functionality',
          severity,
          description: 'Test description',
        };

        const result = submitFinding(args, sessionDb, reportsDb, personaName);

        const report = reportsDb.prepare('SELECT * FROM reports WHERE id = ?').get(result.report_id) as ReportRecord;
        expect(report.priority).toBe(priority);
      });
    });

    it('should handle minimal finding (no optional fields)', () => {
      const args: SubmitFindingArgs = {
        title: 'Minimal finding',
        category: 'usability',
        severity: 'low',
        description: 'This is a minimal finding with no optional fields',
      };

      const result = submitFinding(args, sessionDb, reportsDb, personaName);

      expect(result.id).toBeTruthy();
      expect(result.report_id).toBeTruthy();

      const finding = sessionDb.prepare('SELECT * FROM findings WHERE id = ?').get(result.id) as FindingRecord;
      expect(finding).toBeTruthy();
      expect(finding.steps_to_reproduce).toBe('[]');
      expect(finding.expected_behavior).toBeNull();
      expect(finding.actual_behavior).toBeNull();
      expect(finding.screenshot_ref).toBeNull();
      expect(finding.url).toBeNull();
    });
  });

  describe('submit_summary', () => {
    it('should store summary locally and create report in agent-reports DB', () => {
      const args: SubmitSummaryArgs = {
        overall_impression: 'negative',
        areas_tested: [
          'Authentication flow',
          'Checkout process',
          'Product search',
        ],
        areas_not_tested: [
          'Admin panel - no access',
          'Mobile app - out of scope',
        ],
        confidence: 'high',
        summary_notes: 'Found several critical issues in the checkout flow. Authentication worked well.',
      };

      const result = submitSummary(args, sessionDb, reportsDb, personaName, sessionId);

      expect(result.id).toBe('summary');
      expect(result.report_id).toBeTruthy();
      expect(result.message).toContain('impression: negative');
      expect(result.message).toContain('priority: high');

      // Verify local storage
      const summary = sessionDb.prepare('SELECT * FROM session_summary WHERE id = ?').get(result.id) as SessionSummaryRecord;
      expect(summary).toBeTruthy();
      expect(summary.overall_impression).toBe(args.overall_impression);
      expect(summary.confidence).toBe(args.confidence);
      expect(summary.summary_notes).toBe(args.summary_notes);

      const areasTested = JSON.parse(summary.areas_tested) as string[];
      expect(areasTested).toEqual(args.areas_tested);

      const areasNotTested = JSON.parse(summary.areas_not_tested) as string[];
      expect(areasNotTested).toEqual(args.areas_not_tested);

      // Verify agent-reports bridge
      const report = reportsDb.prepare('SELECT * FROM reports WHERE id = ?').get(result.report_id) as ReportRecord;
      expect(report).toBeTruthy();
      expect(report.reporting_agent).toBe('feedback-power-user');
      expect(report.title).toContain('Feedback Summary');
      expect(report.title).toContain('power-user');
      expect(report.title).toContain('negative');
      expect(report.category).toBe('user-feedback');
      expect(report.priority).toBe('high');
      expect(report.triage_status).toBe('pending');
      expect(report.summary).toContain('Overall Impression: negative');
      expect(report.summary).toContain('Confidence: high');
      expect(report.summary).toContain('Areas Tested (3):');
      expect(report.summary).toContain('Areas Not Tested (2):');
      expect(report.summary).toContain('Notes:');
      expect(report.summary).toContain(sessionId);
    });

    it('should map overall_impression to priority correctly', () => {
      const testCases: Array<{ impression: 'unusable' | 'negative' | 'neutral' | 'positive'; priority: string }> = [
        { impression: 'unusable', priority: 'critical' },
        { impression: 'negative', priority: 'high' },
        { impression: 'neutral', priority: 'normal' },
        { impression: 'positive', priority: 'low' },
      ];

      testCases.forEach(({ impression, priority }) => {
        const args: SubmitSummaryArgs = {
          overall_impression: impression,
          areas_tested: ['Test area'],
          confidence: 'medium',
        };

        const result = submitSummary(args, sessionDb, reportsDb, personaName, sessionId);

        const report = reportsDb.prepare('SELECT * FROM reports WHERE id = ?').get(result.report_id) as ReportRecord;
        expect(report.priority).toBe(priority);
      });
    });

    it('should handle minimal summary (no optional fields)', () => {
      const args: SubmitSummaryArgs = {
        overall_impression: 'positive',
        areas_tested: ['Main feature'],
        confidence: 'low',
      };

      const result = submitSummary(args, sessionDb, reportsDb, personaName, sessionId);

      expect(result.id).toBe('summary');
      expect(result.report_id).toBeTruthy();

      const summary = sessionDb.prepare('SELECT * FROM session_summary WHERE id = ?').get(result.id) as SessionSummaryRecord;
      expect(summary).toBeTruthy();
      expect(summary.areas_not_tested).toBe('[]');
      expect(summary.summary_notes).toBeNull();
    });

    it('should replace existing summary on re-submission', () => {
      const args1: SubmitSummaryArgs = {
        overall_impression: 'neutral',
        areas_tested: ['Feature A'],
        confidence: 'medium',
      };

      const result1 = submitSummary(args1, sessionDb, reportsDb, personaName, sessionId);
      expect(result1.id).toBe('summary');

      const args2: SubmitSummaryArgs = {
        overall_impression: 'positive',
        areas_tested: ['Feature A', 'Feature B'],
        confidence: 'high',
      };

      const result2 = submitSummary(args2, sessionDb, reportsDb, personaName, sessionId);
      expect(result2.id).toBe('summary');

      // Should only have one summary record
      const summaries = sessionDb.prepare('SELECT * FROM session_summary').all() as SessionSummaryRecord[];
      expect(summaries.length).toBe(1);
      expect(summaries[0].overall_impression).toBe('positive');
    });
  });

  describe('list_findings', () => {
    it('should list all findings', () => {
      const finding1: SubmitFindingArgs = {
        title: 'Finding 1',
        category: 'functionality',
        severity: 'high',
        description: 'Description 1',
      };

      const finding2: SubmitFindingArgs = {
        title: 'Finding 2',
        category: 'usability',
        severity: 'medium',
        description: 'Description 2',
      };

      const finding3: SubmitFindingArgs = {
        title: 'Finding 3',
        category: 'functionality',
        severity: 'low',
        description: 'Description 3',
      };

      submitFinding(finding1, sessionDb, reportsDb, personaName);
      submitFinding(finding2, sessionDb, reportsDb, personaName);
      submitFinding(finding3, sessionDb, reportsDb, personaName);

      const result = listFindings({}, sessionDb);

      expect(result.total).toBe(3);
      expect(result.findings.length).toBe(3);
    });

    it('should filter by category', () => {
      const finding1: SubmitFindingArgs = {
        title: 'Finding 1',
        category: 'functionality',
        severity: 'high',
        description: 'Description 1',
      };

      const finding2: SubmitFindingArgs = {
        title: 'Finding 2',
        category: 'usability',
        severity: 'medium',
        description: 'Description 2',
      };

      submitFinding(finding1, sessionDb, reportsDb, personaName);
      submitFinding(finding2, sessionDb, reportsDb, personaName);

      const result = listFindings({ category: 'functionality' }, sessionDb);

      expect(result.total).toBe(1);
      expect(result.findings[0].category).toBe('functionality');
    });

    it('should filter by severity', () => {
      const finding1: SubmitFindingArgs = {
        title: 'Finding 1',
        category: 'functionality',
        severity: 'high',
        description: 'Description 1',
      };

      const finding2: SubmitFindingArgs = {
        title: 'Finding 2',
        category: 'usability',
        severity: 'medium',
        description: 'Description 2',
      };

      submitFinding(finding1, sessionDb, reportsDb, personaName);
      submitFinding(finding2, sessionDb, reportsDb, personaName);

      const result = listFindings({ severity: 'high' }, sessionDb);

      expect(result.total).toBe(1);
      expect(result.findings[0].severity).toBe('high');
    });

    it('should filter by both category and severity', () => {
      const finding1: SubmitFindingArgs = {
        title: 'Finding 1',
        category: 'functionality',
        severity: 'high',
        description: 'Description 1',
      };

      const finding2: SubmitFindingArgs = {
        title: 'Finding 2',
        category: 'functionality',
        severity: 'medium',
        description: 'Description 2',
      };

      const finding3: SubmitFindingArgs = {
        title: 'Finding 3',
        category: 'usability',
        severity: 'high',
        description: 'Description 3',
      };

      submitFinding(finding1, sessionDb, reportsDb, personaName);
      submitFinding(finding2, sessionDb, reportsDb, personaName);
      submitFinding(finding3, sessionDb, reportsDb, personaName);

      const result = listFindings({ category: 'functionality', severity: 'high' }, sessionDb);

      expect(result.total).toBe(1);
      expect(result.findings[0].category).toBe('functionality');
      expect(result.findings[0].severity).toBe('high');
    });

    it('should return empty list when no findings match', () => {
      const finding1: SubmitFindingArgs = {
        title: 'Finding 1',
        category: 'functionality',
        severity: 'high',
        description: 'Description 1',
      };

      submitFinding(finding1, sessionDb, reportsDb, personaName);

      const result = listFindings({ category: 'security' }, sessionDb);

      expect(result.total).toBe(0);
      expect(result.findings.length).toBe(0);
    });
  });

  describe('schema validation', () => {
    it('should reject finding with missing required fields', () => {
      const invalidArgs = {
        title: 'Test',
        // missing category, severity, description
      };

      const validation = SubmitFindingArgsSchema.safeParse(invalidArgs);
      expect(validation.success).toBe(false);
    });

    it('should reject finding with invalid severity', () => {
      const invalidArgs = {
        title: 'Test',
        category: 'functionality',
        severity: 'invalid-severity',
        description: 'Test description',
      };

      const validation = SubmitFindingArgsSchema.safeParse(invalidArgs);
      expect(validation.success).toBe(false);
    });

    it('should reject finding with invalid category', () => {
      const invalidArgs = {
        title: 'Test',
        category: 'invalid-category',
        severity: 'high',
        description: 'Test description',
      };

      const validation = SubmitFindingArgsSchema.safeParse(invalidArgs);
      expect(validation.success).toBe(false);
    });

    it('should reject summary with missing required fields', () => {
      const invalidArgs = {
        overall_impression: 'positive',
        // missing areas_tested, confidence
      };

      const validation = SubmitSummaryArgsSchema.safeParse(invalidArgs);
      expect(validation.success).toBe(false);
    });

    it('should reject summary with invalid overall_impression', () => {
      const invalidArgs = {
        overall_impression: 'invalid-impression',
        areas_tested: ['Feature A'],
        confidence: 'high',
      };

      const validation = SubmitSummaryArgsSchema.safeParse(invalidArgs);
      expect(validation.success).toBe(false);
    });

    it('should reject summary with invalid confidence', () => {
      const invalidArgs = {
        overall_impression: 'positive',
        areas_tested: ['Feature A'],
        confidence: 'invalid-confidence',
      };

      const validation = SubmitSummaryArgsSchema.safeParse(invalidArgs);
      expect(validation.success).toBe(false);
    });

    it('should reject list_findings with invalid category', () => {
      const invalidArgs = {
        category: 'invalid-category',
      };

      const validation = ListFindingsArgsSchema.safeParse(invalidArgs);
      expect(validation.success).toBe(false);
    });

    it('should reject list_findings with invalid severity', () => {
      const invalidArgs = {
        severity: 'invalid-severity',
      };

      const validation = ListFindingsArgsSchema.safeParse(invalidArgs);
      expect(validation.success).toBe(false);
    });
  });

  describe('session isolation', () => {
    it('should isolate findings between different sessions', () => {
      // Create two session databases
      const session1Db = createTestDb(SESSION_SCHEMA);
      const session2Db = createTestDb(SESSION_SCHEMA);

      const finding1: SubmitFindingArgs = {
        title: 'Session 1 Finding',
        category: 'functionality',
        severity: 'high',
        description: 'Finding from session 1',
      };

      const finding2: SubmitFindingArgs = {
        title: 'Session 2 Finding',
        category: 'usability',
        severity: 'medium',
        description: 'Finding from session 2',
      };

      submitFinding(finding1, session1Db, reportsDb, personaName);
      submitFinding(finding2, session2Db, reportsDb, personaName);

      const session1Findings = listFindings({}, session1Db);
      const session2Findings = listFindings({}, session2Db);

      expect(session1Findings.total).toBe(1);
      expect(session1Findings.findings[0].title).toBe('Session 1 Finding');

      expect(session2Findings.total).toBe(1);
      expect(session2Findings.findings[0].title).toBe('Session 2 Finding');

      session1Db.close();
      session2Db.close();
    });
  });
});
