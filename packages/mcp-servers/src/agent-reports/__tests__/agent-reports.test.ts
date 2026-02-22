/**
 * Unit tests for Agent Reports MCP Server
 *
 * Tests report lifecycle, triage operations, G001 fail-closed behavior,
 * G003 input validation, and database operations.
 *
 * Uses in-memory SQLite database for complete test isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

import {
  createTestDb,
  getTimestamp,
  isErrorResult,
} from '../../__testUtils__/index.js';
import {
  AGENT_REPORTS_SCHEMA,
  REPORT_CATEGORIES,
  REPORT_PRIORITIES,
  TRIAGE_STATUS,
} from '../../__testUtils__/schemas.js';
import {
  createReport,
  createReadReport,
  createAcknowledgedReport,
  createTriagedReport,
  createReports,
  insertReport,
  insertReports,
} from '../../__testUtils__/fixtures.js';

// Database row types for type safety
interface ReportRow {
  id: string;
  reporting_agent: string;
  title: string;
  summary: string;
  category: string;
  priority: string;
  created_at: string;
  created_timestamp: number;
  read_at: string | null;
  acknowledged_at: string | null;
  triage_status: string;
  triage_outcome: string | null;
  triage_action: string | null;
  triaged_at: string | null;
}

interface CountResult {
  count: number;
}

// Result types for helper functions
interface ReadReportResult {
  id: string;
  reporting_agent: string;
  title: string;
  summary: string;
  category: string;
  priority: string;
  created_at: string;
  read_at: string;
}

interface AcknowledgeResult {
  id: string;
  acknowledged: boolean;
  message: string;
}

interface TriageResult {
  id: string;
  triage_status: string;
  message: string;
  triage_action?: string;
  triage_outcome?: string;
}

interface ErrorResult {
  error: string;
}

interface CompleteTriageResult {
  id: string;
  status: string;
  outcome: string;
  message: string;
}

type ReadReportResponse = ReadReportResult | ErrorResult;
type AcknowledgeResponse = AcknowledgeResult | ErrorResult;
type TriageResponse = TriageResult | ErrorResult;
type CompleteTriageResponse = CompleteTriageResult | ErrorResult;

describe('Agent Reports Server', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb(AGENT_REPORTS_SCHEMA);
  });

  afterEach(() => {
    db.close();
  });

  // ============================================================================
  // Helper Functions (mirror server implementation)
  // ============================================================================

  const reportToCto = (args: {
    reporting_agent: string;
    title: string;
    summary: string;
    category?: string;
    priority?: string;
  }) => {
    const id = randomUUID();
    const now = new Date();
    const created_at = now.toISOString();
    const created_timestamp = Math.floor(now.getTime() / 1000);

    db.prepare(`
      INSERT INTO reports (id, reporting_agent, title, summary, category, priority, created_at, created_timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      args.reporting_agent,
      args.title,
      args.summary,
      args.category ?? 'other',
      args.priority ?? 'normal',
      created_at,
      created_timestamp
    );

    return {
      id,
      message: `Report submitted for triage. ID: ${id}`,
    };
  };

  const listReports = (args: {
    unread_only?: boolean;
    untriaged_only?: boolean;
    limit?: number;
  }) => {
    let sql =
      'SELECT id, reporting_agent, title, category, priority, created_at, read_at, acknowledged_at, triage_status, triage_outcome FROM reports';
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (args.unread_only) {
      conditions.push('read_at IS NULL');
    }

    if (args.untriaged_only) {
      conditions.push("triage_status = 'pending'");
    }

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }

    sql += ' ORDER BY created_timestamp DESC LIMIT ?';
    params.push(args.limit ?? 20);

    const reports = db.prepare(sql).all(...params) as ReportRow[];

    const unreadCount = (
      db.prepare('SELECT COUNT(*) as count FROM reports WHERE read_at IS NULL').get() as CountResult
    ).count;
    const untriagedCount = (
      db
        .prepare("SELECT COUNT(*) as count FROM reports WHERE triage_status = 'pending'")
        .get() as CountResult
    ).count;

    return {
      reports: reports.map(r => ({
        id: r.id,
        reporting_agent: r.reporting_agent,
        title: r.title,
        category: r.category,
        priority: r.priority,
        created_at: r.created_at,
        is_read: r.read_at !== null,
        is_acknowledged: r.acknowledged_at !== null,
        triage_status: r.triage_status || 'pending',
        triage_outcome: r.triage_outcome,
        is_triaged: r.triage_status !== 'pending',
      })),
      total: reports.length,
      unread_count: unreadCount,
      untriaged_count: untriagedCount,
    };
  };

  const readReport = (id: string) => {
    const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(id) as ReportRow | undefined;

    if (!report) {
      return { error: `Report not found: ${id}` };
    }

    const now = new Date().toISOString();
    if (!report.read_at) {
      db.prepare('UPDATE reports SET read_at = ? WHERE id = ?').run(now, id);
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
  };

  const acknowledgeReport = (id: string) => {
    const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(id) as ReportRow | undefined;

    if (!report) {
      return { error: `Report not found: ${id}` };
    }

    if (!report.read_at) {
      return {
        error: `Cannot acknowledge report ${id} without reading it first. Use read_report to view the full content before acknowledging.`,
      };
    }

    if (report.acknowledged_at) {
      return {
        id,
        acknowledged: true,
        message: `Report already acknowledged at ${report.acknowledged_at}`,
      };
    }

    const now = new Date().toISOString();
    db.prepare('UPDATE reports SET acknowledged_at = ? WHERE id = ?').run(now, id);

    return {
      id,
      acknowledged: true,
      message: 'Report acknowledged. Consider using deputy-cto MCP to add noteworthy items to the CTO question queue.',
    };
  };

  const getUntriagedCount = () => {
    interface PriorityCount {
      priority: string;
      count: number;
    }

    const total = (
      db
        .prepare("SELECT COUNT(*) as count FROM reports WHERE triage_status = 'pending'")
        .get() as CountResult
    ).count;

    const byPriority = db
      .prepare(
        `
      SELECT priority, COUNT(*) as count
      FROM reports
      WHERE triage_status = 'pending'
      GROUP BY priority
    `
      )
      .all() as PriorityCount[];

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
  };

  const startTriage = (args: { id: string; session_id?: string }) => {
    const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(args.id) as ReportRow | undefined;

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
    db.prepare(
      `
      UPDATE reports
      SET triage_status = 'in_progress', triage_started_at = ?, triage_session_id = ?,
          triage_attempted_at = ?, read_at = COALESCE(read_at, ?)
      WHERE id = ?
    `
    ).run(now, args.session_id || null, now, now, args.id);

    return {
      id: args.id,
      started: true,
      message: `Triage started for report: ${report.title}`,
    };
  };

  const completeTriage = (args: {
    id: string;
    status: 'self_handled' | 'escalated' | 'dismissed';
    outcome: string;
  }) => {
    const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(args.id) as ReportRow | undefined;

    if (!report) {
      return { error: `Report not found: ${args.id}` };
    }

    if (report.triage_status !== 'in_progress' && report.triage_status !== 'pending') {
      return { error: `Report already completed with status: ${report.triage_status}` };
    }

    const now = new Date().toISOString();
    db.prepare(
      `
      UPDATE reports
      SET triage_status = ?, triage_completed_at = ?, triage_outcome = ?,
          triaged_at = ?, triage_action = ?,
          acknowledged_at = COALESCE(acknowledged_at, ?)
      WHERE id = ?
    `
    ).run(args.status, now, args.outcome, now, args.status, now, args.id);

    return {
      id: args.id,
      status: args.status,
      outcome: args.outcome,
      message: `Triage completed: ${args.status}`,
    };
  };

  const getTriageStats = (args: {
    recent_window_hours?: number;
    extended_window_hours?: number;
  }) => {
    const now = Date.now();
    const recentCutoff = new Date(now - (args.recent_window_hours ?? 24) * 60 * 60 * 1000).toISOString();
    const extendedCutoff = new Date(now - (args.extended_window_hours ?? 168) * 60 * 60 * 1000).toISOString();

    const pending = (
      db.prepare("SELECT COUNT(*) as count FROM reports WHERE triage_status = 'pending'").get() as CountResult
    ).count;
    const inProgress = (
      db.prepare("SELECT COUNT(*) as count FROM reports WHERE triage_status = 'in_progress'").get() as CountResult
    ).count;

    const selfHandledRecent = (
      db
        .prepare(
          `
        SELECT COUNT(*) as count FROM reports
        WHERE triage_status = 'self_handled' AND triage_completed_at >= ?
      `
        )
        .get(recentCutoff) as CountResult
    ).count;

    const selfHandledExtended = (
      db
        .prepare(
          `
        SELECT COUNT(*) as count FROM reports
        WHERE triage_status = 'self_handled' AND triage_completed_at >= ?
      `
        )
        .get(extendedCutoff) as CountResult
    ).count;

    const escalatedRecent = (
      db
        .prepare(
          `
        SELECT COUNT(*) as count FROM reports
        WHERE triage_status = 'escalated' AND triage_completed_at >= ?
      `
        )
        .get(recentCutoff) as CountResult
    ).count;

    const escalatedExtended = (
      db
        .prepare(
          `
        SELECT COUNT(*) as count FROM reports
        WHERE triage_status = 'escalated' AND triage_completed_at >= ?
      `
        )
        .get(extendedCutoff) as CountResult
    ).count;

    const dismissedRecent = (
      db
        .prepare(
          `
        SELECT COUNT(*) as count FROM reports
        WHERE triage_status = 'dismissed' AND triage_completed_at >= ?
      `
        )
        .get(recentCutoff) as CountResult
    ).count;

    const dismissedExtended = (
      db
        .prepare(
          `
        SELECT COUNT(*) as count FROM reports
        WHERE triage_status = 'dismissed' AND triage_completed_at >= ?
      `
        )
        .get(extendedCutoff) as CountResult
    ).count;

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
    };
  };

  // ============================================================================
  // Report Creation Tests
  // ============================================================================

  describe('Report Creation (report_to_deputy_cto)', () => {
    it('should create a report with required fields', () => {
      const result = reportToCto({
        reporting_agent: 'test-writer',
        title: 'Test failure',
        summary: 'Tests are failing in CI',
      });

      expect(result.id).toBeDefined();
      expect(result.message).toContain('Report submitted for triage');

      const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(result.id) as ReportRow | undefined;
      expect(report.reporting_agent).toBe('test-writer');
      expect(report.title).toBe('Test failure');
      expect(report.summary).toBe('Tests are failing in CI');
      expect(report.category).toBe('other');
      expect(report.priority).toBe('normal');
      expect(report.triage_status).toBe('pending');
    });

    it('should create a report with all fields', () => {
      const result = reportToCto({
        reporting_agent: 'code-reviewer',
        title: 'Security vulnerability found',
        summary: 'SQL injection in user input',
        category: 'security',
        priority: 'critical',
      });

      const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(result.id) as ReportRow | undefined;
      expect(report.category).toBe('security');
      expect(report.priority).toBe('critical');
    });

    it('should enforce valid category constraint (G003)', () => {
      expect(() => {
        db.prepare(
          `
          INSERT INTO reports (id, reporting_agent, title, summary, category, priority, created_at, created_timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
          randomUUID(),
          'test-agent',
          'Test',
          'Summary',
          'invalid-category',
          'normal',
          new Date().toISOString(),
          Math.floor(Date.now() / 1000)
        );
      }).toThrow();
    });

    it('should enforce valid priority constraint (G003)', () => {
      expect(() => {
        db.prepare(
          `
          INSERT INTO reports (id, reporting_agent, title, summary, category, priority, created_at, created_timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
          randomUUID(),
          'test-agent',
          'Test',
          'Summary',
          'other',
          'invalid-priority',
          new Date().toISOString(),
          Math.floor(Date.now() / 1000)
        );
      }).toThrow();
    });

    it('should accept all valid categories', () => {
      for (const category of REPORT_CATEGORIES) {
        const result = reportToCto({
          reporting_agent: 'test',
          title: `Test ${category}`,
          summary: 'Summary',
          category,
        });
        expect(result.id).toBeDefined();
      }
    });

    it('should accept all valid priorities', () => {
      for (const priority of REPORT_PRIORITIES) {
        const result = reportToCto({
          reporting_agent: 'test',
          title: `Test ${priority}`,
          summary: 'Summary',
          priority,
        });
        expect(result.id).toBeDefined();
      }
    });
  });

  // ============================================================================
  // Report Retrieval Tests
  // ============================================================================

  describe('Report Listing (list_reports)', () => {
    it('should list all reports', () => {
      const reports = createReports(5);
      insertReports(db, reports);

      const result = listReports({});
      expect(result.total).toBe(5);
      expect(result.reports).toHaveLength(5);
    });

    it('should filter unread reports', () => {
      const unreadReport = createReport({ title: 'Unread' });
      const readReportData = createReadReport({ title: 'Read' });
      insertReports(db, [unreadReport, readReportData]);

      const result = listReports({ unread_only: true });
      expect(result.total).toBe(1);
      expect(result.reports[0].title).toBe('Unread');
    });

    it('should filter untriaged reports', () => {
      const pendingReport = createReport({ title: 'Pending' });
      const triagedReport = createTriagedReport('self_handled', { title: 'Triaged' });
      insertReports(db, [pendingReport, triagedReport]);

      const result = listReports({ untriaged_only: true });
      expect(result.total).toBe(1);
      expect(result.reports[0].title).toBe('Pending');
    });

    it('should apply limit', () => {
      const reports = createReports(20);
      insertReports(db, reports);

      const result = listReports({ limit: 5 });
      expect(result.reports).toHaveLength(5);
    });

    it('should return counts', () => {
      const reports = [
        createReport({}),
        createReadReport({}),
        createTriagedReport('escalated', {}),
      ];
      insertReports(db, reports);

      const result = listReports({});
      expect(result.unread_count).toBe(1); // First report is unread
      expect(result.untriaged_count).toBe(2); // First two are untriaged
    });

    it('should order by created_timestamp DESC', () => {
      const oldReport = createReport({
        title: 'Old',
        created_timestamp: getTimestamp(-60, 'minutes'),
      });
      const newReport = createReport({
        title: 'New',
        created_timestamp: getTimestamp(0),
      });
      insertReports(db, [oldReport, newReport]);

      const result = listReports({});
      expect(result.reports[0].title).toBe('New');
    });
  });

  // ============================================================================
  // Read Report Tests
  // ============================================================================

  describe('Read Report (read_report)', () => {
    it('should read a report and mark it as read', () => {
      const report = createReport({});
      insertReport(db, report);

      const result = readReport(report.id) as ReadReportResponse;

      expect(result.id).toBe(report.id);
      expect(result.summary).toBe(report.summary);
      expect(result.read_at).toBeDefined();

      // Verify in database
      const updated = db.prepare('SELECT * FROM reports WHERE id = ?').get(report.id) as ReportRow | undefined;
      expect(updated.read_at).not.toBeNull();
    });

    it('should return error for non-existent report (G001)', () => {
      const result = readReport('non-existent');

      expect(isErrorResult(result)).toBe(true);
      if (isErrorResult(result)) {
        expect(result.error).toContain('Report not found');
      }
    });

    it('should not update read_at if already read', () => {
      const report = createReadReport({ read_at: '2025-01-01T00:00:00Z' });
      insertReport(db, report);

      readReport(report.id);

      const updated = db.prepare('SELECT * FROM reports WHERE id = ?').get(report.id) as ReportRow | undefined;
      expect(updated.read_at).toBe('2025-01-01T00:00:00Z');
    });
  });

  // ============================================================================
  // Acknowledge Report Tests
  // ============================================================================

  describe('Acknowledge Report (acknowledge_report)', () => {
    it('should acknowledge a read report', () => {
      const report = createReadReport({});
      insertReport(db, report);

      const result = acknowledgeReport(report.id) as AcknowledgeResponse;

      expect(result.acknowledged).toBe(true);
      expect(result.message).toContain('Report acknowledged');

      const updated = db.prepare('SELECT * FROM reports WHERE id = ?').get(report.id) as ReportRow | undefined;
      expect(updated.acknowledged_at).not.toBeNull();
    });

    it('should fail if report not read first (G001)', () => {
      const report = createReport({}); // Not read
      insertReport(db, report);

      const result = acknowledgeReport(report.id) as AcknowledgeResponse;

      expect(isErrorResult(result)).toBe(true);
      if (isErrorResult(result)) {
        expect(result.error).toContain('without reading it first');
      }
    });

    it('should return error for non-existent report (G001)', () => {
      const result = acknowledgeReport('non-existent');

      expect(isErrorResult(result)).toBe(true);
      if (isErrorResult(result)) {
        expect(result.error).toContain('Report not found');
      }
    });

    it('should indicate if already acknowledged', () => {
      const report = createAcknowledgedReport({});
      insertReport(db, report);

      const result = acknowledgeReport(report.id) as AcknowledgeResponse;

      expect(result.acknowledged).toBe(true);
      expect(result.message).toContain('already acknowledged');
    });
  });

  // ============================================================================
  // Untriaged Count Tests
  // ============================================================================

  describe('Get Untriaged Count (get_untriaged_count)', () => {
    it('should return zero for empty database', () => {
      const result = getUntriagedCount();

      expect(result.untriaged_count).toBe(0);
      expect(result.by_priority.critical).toBe(0);
      expect(result.by_priority.high).toBe(0);
      expect(result.by_priority.normal).toBe(0);
      expect(result.by_priority.low).toBe(0);
    });

    it('should count untriaged reports', () => {
      const reports = [
        createReport({ priority: 'critical' }),
        createReport({ priority: 'high' }),
        createReport({ priority: 'normal' }),
        createReport({ priority: 'normal' }),
      ];
      insertReports(db, reports);

      const result = getUntriagedCount();

      expect(result.untriaged_count).toBe(4);
      expect(result.by_priority.critical).toBe(1);
      expect(result.by_priority.high).toBe(1);
      expect(result.by_priority.normal).toBe(2);
    });

    it('should exclude triaged reports', () => {
      const pending = createReport({ priority: 'high' });
      const triaged = createTriagedReport('self_handled', { priority: 'critical' });
      insertReports(db, [pending, triaged]);

      const result = getUntriagedCount();

      expect(result.untriaged_count).toBe(1);
      expect(result.by_priority.high).toBe(1);
      expect(result.by_priority.critical).toBe(0);
    });
  });

  // ============================================================================
  // Triage Lifecycle Tests
  // ============================================================================

  describe('Triage Lifecycle', () => {
    describe('Start Triage (start_triage)', () => {
      it('should start triage on pending report', () => {
        const report = createReport({});
        insertReport(db, report);

        const result = startTriage({ id: report.id }) as TriageResponse;

        expect(result.started).toBe(true);
        expect(result.message).toContain('Triage started');

        const updated = db.prepare('SELECT * FROM reports WHERE id = ?').get(report.id) as ReportRow | undefined;
        expect(updated.triage_status).toBe('in_progress');
        expect(updated.triage_started_at).not.toBeNull();
        expect(updated.read_at).not.toBeNull(); // Auto-marked as read
      });

      it('should record session_id if provided', () => {
        const report = createReport({});
        insertReport(db, report);

        startTriage({ id: report.id, session_id: 'test-session-123' });

        const updated = db.prepare('SELECT * FROM reports WHERE id = ?').get(report.id) as ReportRow | undefined;
        expect(updated.triage_session_id).toBe('test-session-123');
      });

      it('should fail if already in progress', () => {
        const report = createReport({
          triage_status: 'in_progress',
          triage_started_at: new Date().toISOString(),
        });
        insertReport(db, report);

        const result = startTriage({ id: report.id }) as TriageResponse;

        expect(result.started).toBe(false);
        expect(result.message).toContain('already being triaged');
      });

      it('should fail if already triaged', () => {
        const report = createTriagedReport('escalated', {});
        insertReport(db, report);

        const result = startTriage({ id: report.id }) as TriageResponse;

        expect(result.started).toBe(false);
        expect(result.message).toContain('already triaged');
      });

      it('should return error for non-existent report (G001)', () => {
        const result = startTriage({ id: 'non-existent' });

        expect(isErrorResult(result)).toBe(true);
      });
    });

    describe('Complete Triage (complete_triage)', () => {
      it('should complete triage with self_handled', () => {
        const report = createReport({
          triage_status: 'in_progress',
          triage_started_at: new Date().toISOString(),
        });
        insertReport(db, report);

        const result = completeTriage({
          id: report.id,
          status: 'self_handled',
          outcome: 'Spawned task to fix',
        }) as CompleteTriageResponse;

        expect(result.status).toBe('self_handled');
        expect(result.outcome).toBe('Spawned task to fix');

        const updated = db.prepare('SELECT * FROM reports WHERE id = ?').get(report.id) as ReportRow | undefined;
        expect(updated.triage_status).toBe('self_handled');
        expect(updated.triage_completed_at).not.toBeNull();
        expect(updated.acknowledged_at).not.toBeNull(); // Auto-acknowledged
      });

      it('should complete triage with escalated', () => {
        const report = createReport({
          triage_status: 'in_progress',
          triage_started_at: new Date().toISOString(),
        });
        insertReport(db, report);

        const result = completeTriage({
          id: report.id,
          status: 'escalated',
          outcome: 'Added to CTO queue',
        }) as CompleteTriageResponse;

        expect(result.status).toBe('escalated');
      });

      it('should complete triage with dismissed', () => {
        const report = createReport({
          triage_status: 'in_progress',
          triage_started_at: new Date().toISOString(),
        });
        insertReport(db, report);

        const result = completeTriage({
          id: report.id,
          status: 'dismissed',
          outcome: 'Not a real issue',
        }) as CompleteTriageResponse;

        expect(result.status).toBe('dismissed');
      });

      it('should allow completing pending reports directly', () => {
        const report = createReport({});
        insertReport(db, report);

        const result = completeTriage({
          id: report.id,
          status: 'self_handled',
          outcome: 'Quick fix applied',
        }) as CompleteTriageResponse;

        expect(result.status).toBe('self_handled');
      });

      it('should fail if already completed', () => {
        const report = createTriagedReport('escalated', {});
        insertReport(db, report);

        const result = completeTriage({
          id: report.id,
          status: 'self_handled',
          outcome: 'Trying to re-triage',
        });

        expect(isErrorResult(result)).toBe(true);
        if (isErrorResult(result)) {
          expect(result.error).toContain('already completed');
        }
      });

      it('should return error for non-existent report (G001)', () => {
        const result = completeTriage({
          id: 'non-existent',
          status: 'self_handled',
          outcome: 'Test',
        });

        expect(isErrorResult(result)).toBe(true);
      });
    });
  });

  // ============================================================================
  // Triage Stats Tests
  // ============================================================================

  describe('Get Triage Stats (get_triage_stats)', () => {
    it('should return zero stats for empty database', () => {
      const result = getTriageStats({});

      expect(result.stats.pending).toBe(0);
      expect(result.stats.in_progress).toBe(0);
      expect(result.stats.self_handled_24h).toBe(0);
      expect(result.stats.escalated_24h).toBe(0);
      expect(result.stats.dismissed_24h).toBe(0);
    });

    it('should count pending and in_progress', () => {
      const reports = [
        createReport({}),
        createReport({ triage_status: 'in_progress', triage_started_at: new Date().toISOString() }),
        createReport({}),
      ];
      insertReports(db, reports);

      const result = getTriageStats({});

      expect(result.stats.pending).toBe(2);
      expect(result.stats.in_progress).toBe(1);
    });

    it('should count completed within time windows', () => {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
      const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();

      const reports = [
        // Recent (within 24h)
        createTriagedReport('self_handled', { triage_completed_at: oneHourAgo }),
        createTriagedReport('escalated', { triage_completed_at: oneHourAgo }),
        // Older (within 7d but not 24h)
        createTriagedReport('dismissed', { triage_completed_at: twoDaysAgo }),
      ];
      insertReports(db, reports);

      const result = getTriageStats({});

      expect(result.stats.self_handled_24h).toBe(1);
      expect(result.stats.escalated_24h).toBe(1);
      expect(result.stats.dismissed_24h).toBe(0);
      expect(result.stats.dismissed_7d).toBe(1);
    });
  });

  // ============================================================================
  // Database Schema Tests
  // ============================================================================

  describe('Database Schema', () => {
    it('should have index on created_timestamp', () => {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_reports_created'")
        .all();
      expect(indexes).toHaveLength(1);
    });

    it('should have index on triage_status', () => {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_reports_triage_status'")
        .all();
      expect(indexes).toHaveLength(1);
    });

    it('should enforce triage_status constraint', () => {
      expect(() => {
        db.prepare(
          `
          INSERT INTO reports (id, reporting_agent, title, summary, category, priority, created_at, created_timestamp, triage_status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
          randomUUID(),
          'test',
          'Test',
          'Summary',
          'other',
          'normal',
          new Date().toISOString(),
          Math.floor(Date.now() / 1000),
          'invalid_status'
        );
      }).toThrow();
    });

    it('should accept all valid triage statuses', () => {
      for (const status of TRIAGE_STATUS) {
        const id = randomUUID();
        db.prepare(
          `
          INSERT INTO reports (id, reporting_agent, title, summary, category, priority, created_at, created_timestamp, triage_status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
          id,
          'test',
          `Test ${status}`,
          'Summary',
          'other',
          'normal',
          new Date().toISOString(),
          Math.floor(Date.now() / 1000),
          status
        );

        const report = db.prepare('SELECT triage_status FROM reports WHERE id = ?').get(id) as ReportRow | undefined;
        expect(report.triage_status).toBe(status);
      }
    });
  });

  // ============================================================================
  // Error Handling Tests (G001)
  // ============================================================================

  describe('Error Handling (G001)', () => {
    it('should fail-closed on non-existent report operations', () => {
      const nonExistentId = 'non-existent-id';

      expect(isErrorResult(readReport(nonExistentId))).toBe(true);
      expect(isErrorResult(acknowledgeReport(nonExistentId))).toBe(true);
      expect(isErrorResult(startTriage({ id: nonExistentId }))).toBe(true);
      expect(
        isErrorResult(
          completeTriage({ id: nonExistentId, status: 'self_handled', outcome: 'Test' })
        )
      ).toBe(true);
    });

    it('should distinguish not-found from other errors', () => {
      const result = readReport('non-existent') as ReadReportResponse;

      expect(result.error).toContain('Report not found');
      expect(result.error).not.toContain('corrupt');
    });
  });

});
