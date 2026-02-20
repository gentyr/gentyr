#!/usr/bin/env node
/**
 * Feedback Explorer MCP Server
 *
 * Read-only exploration of the feedback system: personas, sessions, findings,
 * CTO reports, and satisfaction levels.
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (stdio MCP)
 *
 * @version 1.0.0
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { McpServer, type AnyToolHandler } from '../shared/server.js';
import { openReadonlyDb } from '../shared/readonly-db.js';
import {
  ListFeedbackPersonasArgsSchema,
  GetPersonaDetailsArgsSchema,
  ListPersonaSessionsArgsSchema,
  GetSessionDetailsArgsSchema,
  ListPersonaReportsArgsSchema,
  GetReportDetailsArgsSchema,
  GetFeedbackOverviewArgsSchema,
  type ListFeedbackPersonasArgs,
  type GetPersonaDetailsArgs,
  type ListPersonaSessionsArgs,
  type GetSessionDetailsArgs,
  type ListPersonaReportsArgs,
  type GetReportDetailsArgs,
  type GetFeedbackOverviewArgs,
  type PersonaRecord,
  type FeedbackSessionRecord,
  type FindingRecord,
  type SessionSummaryRecord,
  type ReportRecord,
  type ErrorResult,
  type ListFeedbackPersonasResult,
  type PersonaDetails,
  type ListPersonaSessionsResult,
  type GetSessionDetailsResult,
  type ListPersonaReportsResult,
  type ReportDetails,
  type GetFeedbackOverviewResult,
  type PersonaSummary,
  type FeatureMapping,
  type SessionSummary,
  type SatisfactionHistory,
  type SessionListItem,
  type Finding,
  type Summary,
  type AuditEvent,
  type ReportListItem,
  type SatisfactionDistribution,
  type RecentSession,
  type ConsumptionMode,
  type SessionStatus,
  type SatisfactionLevel,
} from './types.js';

// ============================================================================
// Configuration Interface
// ============================================================================

export interface FeedbackExplorerConfig {
  projectDir: string;
  // Test overrides: provide pre-created DB instances
  userFeedbackDb?: Database.Database;
  ctoReportsDb?: Database.Database;
  sessionEventsDb?: Database.Database;
}

// ============================================================================
// Server Factory Function
// ============================================================================

export function createFeedbackExplorerServer(config: FeedbackExplorerConfig): McpServer {
  // ============================================================================
  // Database Management
  // ============================================================================

  let _userFeedbackDb: Database.Database | null = null;
  let _ctoReportsDb: Database.Database | null = null;
  let _sessionEventsDb: Database.Database | null = null;

  function getUserFeedbackDb(): Database.Database {
    if (!_userFeedbackDb) {
      if (config.userFeedbackDb) {
        _userFeedbackDb = config.userFeedbackDb;
      } else {
        const dbPath = path.join(config.projectDir, '.claude', 'user-feedback.db');
        if (!fs.existsSync(dbPath)) {
          throw new Error(`user-feedback.db not found at ${dbPath}`);
        }
        _userFeedbackDb = openReadonlyDb(dbPath);
      }
    }
    return _userFeedbackDb;
  }

  function getCtoReportsDb(): Database.Database {
    if (!_ctoReportsDb) {
      if (config.ctoReportsDb) {
        _ctoReportsDb = config.ctoReportsDb;
      } else {
        const dbPath = path.join(config.projectDir, '.claude', 'cto-reports.db');
        if (!fs.existsSync(dbPath)) {
          throw new Error(`cto-reports.db not found at ${dbPath}`);
        }
        _ctoReportsDb = openReadonlyDb(dbPath);
      }
    }
    return _ctoReportsDb;
  }

  function getSessionEventsDb(): Database.Database {
    if (!_sessionEventsDb) {
      if (config.sessionEventsDb) {
        _sessionEventsDb = config.sessionEventsDb;
      } else {
        const dbPath = path.join(config.projectDir, '.claude', 'session-events.db');
        if (!fs.existsSync(dbPath)) {
          throw new Error(`session-events.db not found at ${dbPath}`);
        }
        _sessionEventsDb = openReadonlyDb(dbPath);
      }
    }
    return _sessionEventsDb;
  }

  function closeDbs(): void {
    if (_userFeedbackDb && !config.userFeedbackDb) {
      _userFeedbackDb.close();
      _userFeedbackDb = null;
    }
    if (_ctoReportsDb && !config.ctoReportsDb) {
      _ctoReportsDb.close();
      _ctoReportsDb = null;
    }
    if (_sessionEventsDb && !config.sessionEventsDb) {
      _sessionEventsDb.close();
      _sessionEventsDb = null;
    }
  }

  function openSessionDb(sessionId: string): Database.Database {
    const sessionsDir = path.join(config.projectDir, '.claude', 'feedback-sessions');
    const sessionDbPath = path.join(sessionsDir, `${sessionId}.db`);
    if (!fs.existsSync(sessionDbPath)) {
      throw new Error(`Session database not found at ${sessionDbPath}`);
    }
    return openReadonlyDb(sessionDbPath);
  }

  // ============================================================================
  // Tool Handlers
  // ============================================================================

  function listFeedbackPersonas(args: ListFeedbackPersonasArgs): ListFeedbackPersonasResult | ErrorResult {
    try {
      const db = getUserFeedbackDb();

      let sql = `
        SELECT
          p.id,
          p.name,
          p.description,
          p.consumption_mode,
          p.enabled,
          p.created_at,
          COUNT(DISTINCT fs.id) as session_count,
          COALESCE(SUM(fs.findings_count), 0) as findings_count,
          (SELECT fs2.satisfaction_level FROM feedback_sessions fs2 WHERE fs2.persona_id = p.id AND fs2.satisfaction_level IS NOT NULL AND fs2.completed_at IS NOT NULL ORDER BY fs2.completed_at DESC LIMIT 1) as latest_satisfaction
        FROM personas p
        LEFT JOIN feedback_sessions fs ON fs.persona_id = p.id
      `;

      const conditions: string[] = [];
      const params: unknown[] = [];

      if (args.enabled_only) {
        conditions.push('p.enabled = 1');
      }
      if (args.consumption_mode) {
        conditions.push('p.consumption_mode = ?');
        params.push(args.consumption_mode);
      }

      if (conditions.length > 0) {
        sql += ` WHERE ${conditions.join(' AND ')}`;
      }

      sql += ' GROUP BY p.id ORDER BY p.created_timestamp DESC';

      interface QueryRow {
        id: string;
        name: string;
        description: string;
        consumption_mode: ConsumptionMode;
        enabled: number;
        created_at: string;
        session_count: number;
        findings_count: number;
        latest_satisfaction?: SatisfactionLevel | null;
      }

      const rows = db.prepare(sql).all(...params) as QueryRow[];

      const personas: PersonaSummary[] = rows.map(row => ({
        id: row.id,
        name: row.name,
        description: row.description,
        consumption_mode: row.consumption_mode,
        enabled: row.enabled === 1,
        session_count: row.session_count,
        findings_count: row.findings_count,
        latest_satisfaction: row.latest_satisfaction ?? null,
        created_at: row.created_at,
      }));

      return { personas, total: personas.length };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to list personas: ${message}` };
    }
  }

  function getPersonaDetails(args: GetPersonaDetailsArgs): PersonaDetails | ErrorResult {
    try {
      const db = getUserFeedbackDb();

      const persona = db.prepare('SELECT * FROM personas WHERE id = ?').get(args.persona_id) as PersonaRecord | undefined;

      if (!persona) {
        return { error: `Persona not found: ${args.persona_id}` };
      }

      // Get feature mappings
      interface FeatureMappingRow {
        feature_id: string;
        priority: string;
        test_scenarios: string;
        feature_name: string;
      }

      const featureMappings = db.prepare(`
        SELECT pf.feature_id, pf.priority, pf.test_scenarios, f.name as feature_name
        FROM persona_features pf
        JOIN features f ON f.id = pf.feature_id
        WHERE pf.persona_id = ?
        ORDER BY
          CASE pf.priority
            WHEN 'critical' THEN 1
            WHEN 'high' THEN 2
            WHEN 'normal' THEN 3
            WHEN 'low' THEN 4
          END
      `).all(args.persona_id) as FeatureMappingRow[];

      const features: FeatureMapping[] = featureMappings.map(m => ({
        feature_id: m.feature_id,
        feature_name: m.feature_name,
        priority: m.priority,
        test_scenarios: JSON.parse(m.test_scenarios) as string[],
      }));

      // Get recent sessions (last 5)
      const sessionSql = 'SELECT id, status, started_at, completed_at, findings_count, satisfaction_level FROM feedback_sessions WHERE persona_id = ? ORDER BY started_at DESC LIMIT 5';

      interface SessionRow {
        id: string;
        status: SessionStatus;
        started_at: string | null;
        completed_at: string | null;
        findings_count: number;
        satisfaction_level?: SatisfactionLevel | null;
      }

      const sessionRows = db.prepare(sessionSql).all(args.persona_id) as SessionRow[];

      const recent_sessions: SessionSummary[] = sessionRows.map(s => ({
        session_id: s.id,
        status: s.status,
        started_at: s.started_at,
        completed_at: s.completed_at,
        findings_count: s.findings_count,
        satisfaction_level: s.satisfaction_level ?? null,
      }));

      // Get satisfaction history
      interface SatisfactionRow {
        id: string;
        satisfaction_level: SatisfactionLevel;
        completed_at: string;
      }

      const satisfactionRows = db.prepare(`
        SELECT id, satisfaction_level, completed_at
        FROM feedback_sessions
        WHERE persona_id = ? AND satisfaction_level IS NOT NULL
        ORDER BY completed_at DESC
        LIMIT 10
      `).all(args.persona_id) as SatisfactionRow[];

      const satisfaction_history: SatisfactionHistory[] = satisfactionRows.map(s => ({
        session_id: s.id,
        satisfaction_level: s.satisfaction_level,
        completed_at: s.completed_at,
      }));

      return {
        id: persona.id,
        name: persona.name,
        description: persona.description,
        consumption_mode: persona.consumption_mode,
        behavior_traits: JSON.parse(persona.behavior_traits) as string[],
        endpoints: JSON.parse(persona.endpoints) as string[],
        credentials_ref: persona.credentials_ref,
        enabled: persona.enabled === 1,
        created_at: persona.created_at,
        updated_at: persona.updated_at,
        features,
        recent_sessions,
        satisfaction_history,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to get persona details: ${message}` };
    }
  }

  function listPersonaSessions(args: ListPersonaSessionsArgs): ListPersonaSessionsResult | ErrorResult {
    try {
      const db = getUserFeedbackDb();

      const sessionSql = 'SELECT id, run_id, status, started_at, completed_at, findings_count, satisfaction_level FROM feedback_sessions WHERE persona_id = ? ORDER BY started_at DESC LIMIT ? OFFSET ?';

      interface SessionRow {
        id: string;
        run_id: string;
        status: SessionStatus;
        started_at: string | null;
        completed_at: string | null;
        findings_count: number;
        satisfaction_level?: SatisfactionLevel | null;
      }

      const rows = db.prepare(sessionSql).all(args.persona_id, args.limit, args.offset) as SessionRow[];

      const sessions: SessionListItem[] = rows.map(row => ({
        id: row.id,
        run_id: row.run_id,
        status: row.status,
        started_at: row.started_at,
        completed_at: row.completed_at,
        findings_count: row.findings_count,
        satisfaction_level: row.satisfaction_level ?? null,
      }));

      return { sessions, total: sessions.length };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to list sessions: ${message}` };
    }
  }

  function getSessionDetails(args: GetSessionDetailsArgs): GetSessionDetailsResult | ErrorResult {
    try {
      const db = getUserFeedbackDb();
      const session = db.prepare('SELECT * FROM feedback_sessions WHERE id = ?').get(args.session_id) as FeedbackSessionRecord | undefined;

      if (!session) {
        return { error: `Session not found: ${args.session_id}` };
      }

      // Get persona name
      interface PersonaRow { name: string }
      const persona = db.prepare('SELECT name FROM personas WHERE id = ?').get(session.persona_id) as PersonaRow | undefined;

      // Open per-session DB to read findings and summary
      const sessionDb = openSessionDb(args.session_id);

      // Read findings
      const findingRows = sessionDb.prepare('SELECT * FROM findings ORDER BY created_at ASC').all() as FindingRecord[];

      const findings = findingRows.map(f => {
          const finding: Finding = {
            id: f.id,
            title: f.title,
            category: f.category,
            severity: f.severity,
            description: f.description,
            created_at: f.created_at,
          };

          const stepsToReproduce = JSON.parse(f.steps_to_reproduce) as string[];
          if (stepsToReproduce.length > 0) {
            finding.steps_to_reproduce = stepsToReproduce;
          }

          if (f.expected_behavior) {
            finding.expected_behavior = f.expected_behavior;
          }

          if (f.actual_behavior) {
            finding.actual_behavior = f.actual_behavior;
          }

          if (f.screenshot_ref) {
            finding.screenshot_ref = f.screenshot_ref;
          }

          if (f.url) {
            finding.url = f.url;
          }

          if (f.report_id) {
            finding.report_id = f.report_id;
          }

          return finding;
        });

      // Read summary
      const summaryRow = sessionDb.prepare('SELECT * FROM session_summary WHERE id = ?').get('summary') as SessionSummaryRecord | undefined;

      let summary: Summary | null = null;
      if (summaryRow) {
        summary = {
          overall_impression: summaryRow.overall_impression,
          areas_tested: JSON.parse(summaryRow.areas_tested) as string[],
          areas_not_tested: JSON.parse(summaryRow.areas_not_tested) as string[],
          confidence: summaryRow.confidence,
          created_at: summaryRow.created_at,
        };

        if (summaryRow.summary_notes) {
          summary.summary_notes = summaryRow.summary_notes;
        }

        if (summaryRow.satisfaction_level) {
          summary.satisfaction_level = summaryRow.satisfaction_level;
        }
      }

      sessionDb.close();

      const result: GetSessionDetailsResult = {
        session_id: args.session_id,
        persona_id: session.persona_id,
        persona_name: persona?.name ?? null,
        run_id: session.run_id,
        status: session.status,
        started_at: session.started_at,
        completed_at: session.completed_at,
        findings,
        summary,
      };

      // Include audit trail if requested
      if (args.include_audit) {
        const eventsDb = getSessionEventsDb();

        interface EventRow {
          timestamp: string;
          input: string | null;
          output: string | null;
          error: string | null;
          duration_ms: number | null;
          metadata: string | null;
        }

        const eventRows = eventsDb.prepare(`
          SELECT timestamp, input, output, error, duration_ms, metadata
          FROM session_events
          WHERE session_id = ? AND event_type IN ('mcp_tool_call', 'mcp_tool_error')
          ORDER BY timestamp ASC
        `).all(args.session_id) as EventRow[];

        const events: AuditEvent[] = [];
        let totalDuration = 0;

        for (const event of eventRows) {
          let inputData: Record<string, unknown> = {};
          let outputData: unknown = null;
          let errorData: unknown = null;
          let metadataData: Record<string, unknown> = {};

          try {
            if (event.input) {
              inputData = JSON.parse(event.input) as Record<string, unknown>;
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[feedback-explorer] Failed to parse audit input JSON: ${msg}\n`);
          }

          try {
            if (event.output) {
              outputData = JSON.parse(event.output) as unknown;
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[feedback-explorer] Failed to parse audit output JSON: ${msg}\n`);
          }

          try {
            if (event.error) {
              errorData = JSON.parse(event.error) as unknown;
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[feedback-explorer] Failed to parse audit error JSON: ${msg}\n`);
          }

          try {
            if (event.metadata) {
              metadataData = JSON.parse(event.metadata) as Record<string, unknown>;
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[feedback-explorer] Failed to parse audit metadata JSON: ${msg}\n`);
          }

          events.push({
            timestamp: event.timestamp,
            tool: (inputData.tool as string) || (inputData.name as string) || 'unknown',
            args: inputData.args || inputData.arguments || null,
            result: outputData,
            error: errorData,
            duration_ms: event.duration_ms,
            mcp_server: (metadataData.mcp_server as string) || null,
          });

          if (event.duration_ms) {
            totalDuration += event.duration_ms;
          }
        }

        result.audit_trail = {
          total_actions: events.length,
          total_duration_ms: totalDuration,
          events,
        };
      }

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to get session details: ${message}` };
    }
  }

  function listPersonaReports(args: ListPersonaReportsArgs): ListPersonaReportsResult | ErrorResult {
    try {
      const db = getCtoReportsDb();

      const reportingAgent = `feedback-${args.persona_name}`;

      const reports = db.prepare(`
        SELECT id, title, category, priority, created_at, triage_status, triage_outcome
        FROM reports
        WHERE reporting_agent = ?
        ORDER BY created_timestamp DESC
        LIMIT ?
      `).all(reportingAgent, args.limit) as {
        id: string;
        title: string;
        category: string;
        priority: string;
        created_at: string;
        triage_status: string;
        triage_outcome: string | null;
      }[];

      const items: ReportListItem[] = reports.map(r => ({
        id: r.id,
        title: r.title,
        category: r.category,
        priority: r.priority,
        created_at: r.created_at,
        triage_status: r.triage_status || 'pending',
        triage_outcome: r.triage_outcome,
      }));

      return {
        persona_name: args.persona_name,
        reports: items,
        total: items.length,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to list persona reports: ${message}` };
    }
  }

  function getReportDetails(args: GetReportDetailsArgs): ReportDetails | ErrorResult {
    try {
      const db = getCtoReportsDb();
      const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(args.report_id) as ReportRecord | undefined;

      if (!report) {
        return { error: `Report not found: ${args.report_id}` };
      }

      return {
        id: report.id,
        reporting_agent: report.reporting_agent,
        title: report.title,
        summary: report.summary,
        category: report.category,
        priority: report.priority,
        created_at: report.created_at,
        read_at: report.read_at,
        acknowledged_at: report.acknowledged_at,
        triage_status: report.triage_status || 'pending',
        triage_started_at: report.triage_started_at,
        triage_completed_at: report.triage_completed_at,
        triage_session_id: report.triage_session_id,
        triage_outcome: report.triage_outcome,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to get report details: ${message}` };
    }
  }

  function getFeedbackOverview(args: GetFeedbackOverviewArgs): GetFeedbackOverviewResult | ErrorResult {
    try {
      const db = getUserFeedbackDb();

      // Time window
      const cutoffTime = new Date(Date.now() - args.hours * 60 * 60 * 1000).toISOString();

      // Persona count
      interface CountResult { count: number }
      const personaCount = (db.prepare('SELECT COUNT(*) as count FROM personas').get() as CountResult).count;

      // Total sessions
      const totalSessions = (db.prepare('SELECT COUNT(*) as count FROM feedback_sessions').get() as CountResult).count;

      // Recent sessions
      const recentSessions = (db.prepare('SELECT COUNT(*) as count FROM feedback_sessions WHERE started_at >= ?').get(cutoffTime) as CountResult).count;

      // Total findings
      interface FindingsResult { total_findings: number | null }
      const totalFindings = (db.prepare('SELECT SUM(findings_count) as total_findings FROM feedback_sessions').get() as FindingsResult).total_findings ?? 0;

      // Satisfaction distribution
      const satisfaction_distribution: SatisfactionDistribution = {
        very_satisfied: 0,
        satisfied: 0,
        neutral: 0,
        dissatisfied: 0,
        very_dissatisfied: 0,
      };

      interface SatisfactionCount { satisfaction_level: SatisfactionLevel; count: number }
      const satisfactionCounts = db.prepare(`
        SELECT satisfaction_level, COUNT(*) as count
        FROM feedback_sessions
        WHERE satisfaction_level IS NOT NULL
        GROUP BY satisfaction_level
      `).all() as SatisfactionCount[];

      for (const row of satisfactionCounts) {
        if (row.satisfaction_level in satisfaction_distribution) {
          satisfaction_distribution[row.satisfaction_level] = row.count;
        }
      }

      // Recent session list
      const sessionSql = `
        SELECT fs.id, p.name as persona_name, fs.status, fs.completed_at, fs.findings_count, fs.satisfaction_level
        FROM feedback_sessions fs
        JOIN personas p ON p.id = fs.persona_id
        WHERE fs.started_at >= ?
        ORDER BY fs.started_at DESC
        LIMIT 10
      `;

      interface SessionRow {
        id: string;
        persona_name: string;
        status: SessionStatus;
        completed_at: string | null;
        findings_count: number;
        satisfaction_level?: SatisfactionLevel | null;
      }

      const sessionRows = db.prepare(sessionSql).all(cutoffTime) as SessionRow[];

      const recent_session_list: RecentSession[] = sessionRows.map(s => ({
        session_id: s.id,
        persona_name: s.persona_name,
        status: s.status,
        completed_at: s.completed_at,
        findings_count: s.findings_count,
        satisfaction_level: s.satisfaction_level ?? null,
      }));

      return {
        time_window_hours: args.hours,
        persona_count: personaCount,
        total_sessions: totalSessions,
        recent_sessions: recentSessions,
        total_findings: totalFindings,
        satisfaction_distribution,
        recent_session_list,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to get feedback overview: ${message}` };
    }
  }

  // ============================================================================
  // Server Setup
  // ============================================================================

  const tools: AnyToolHandler[] = [
    {
      name: 'list_feedback_personas',
      description: 'List all personas with enriched data: session count, findings count, latest satisfaction level. Filter by enabled status or consumption mode.',
      schema: ListFeedbackPersonasArgsSchema,
      handler: listFeedbackPersonas,
    },
    {
      name: 'get_persona_details',
      description: 'Get full persona details including mapped features, recent sessions (last 5), and satisfaction history (last 10).',
      schema: GetPersonaDetailsArgsSchema,
      handler: getPersonaDetails,
    },
    {
      name: 'list_persona_sessions',
      description: 'List paginated sessions for a persona with satisfaction levels. Use limit/offset for pagination.',
      schema: ListPersonaSessionsArgsSchema,
      handler: listPersonaSessions,
    },
    {
      name: 'get_session_details',
      description: 'Get full session details including findings, summary, and optionally audit trail (MCP tool calls made during session).',
      schema: GetSessionDetailsArgsSchema,
      handler: getSessionDetails,
    },
    {
      name: 'list_persona_reports',
      description: 'List CTO reports submitted by a specific persona. Persona name must match the reporting_agent pattern (e.g., "power-user" for "feedback-power-user").',
      schema: ListPersonaReportsArgsSchema,
      handler: listPersonaReports,
    },
    {
      name: 'get_report_details',
      description: 'Get full details of a CTO report including triage status, outcome, and timestamps.',
      schema: GetReportDetailsArgsSchema,
      handler: getReportDetails,
    },
    {
      name: 'get_feedback_overview',
      description: 'Get high-level feedback system overview: persona count, session counts, total findings, satisfaction distribution, and recent sessions. Defaults to 7-day window.',
      schema: GetFeedbackOverviewArgsSchema,
      handler: getFeedbackOverview,
    },
  ];

  const server = new McpServer({
    name: 'feedback-explorer',
    version: '1.0.0',
    tools,
  });

  // Close DBs we created (not test-provided ones) on process exit
  if (!config.userFeedbackDb || !config.ctoReportsDb || !config.sessionEventsDb) {
    process.on('exit', () => { closeDbs(); });
  }

  return server;
}

// ============================================================================
// Auto-start Guard (Module Entry Point)
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const projectDir = path.resolve(process.env['CLAUDE_PROJECT_DIR'] || process.cwd());
  const server = createFeedbackExplorerServer({ projectDir });
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  server.start();
}
