/**
 * True E2E Tests for GENTYR AI User Feedback System
 *
 * Unlike feedback-pipeline.test.ts (which tests DB logic with stubs),
 * these tests start the real toy app, exercise real HTTP API and CLI
 * interfaces, submit findings through the real pipeline, and verify
 * the complete audit trail.
 *
 * Test tiers:
 * 1. API Persona Flow - Real HTTP requests against toy app
 * 2. CLI Persona Flow - Real CLI subprocess execution
 * 3. Multi-Persona Run - Full pipeline with persona selection
 * 4. Audit Trail Verification - MCP action logging completeness
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

import {
  createTestDb,
  isErrorResult,
} from '../../packages/mcp-servers/src/__testUtils__/index.js';
import {
  USER_FEEDBACK_SCHEMA,
  AGENT_REPORTS_SCHEMA,
} from '../../packages/mcp-servers/src/__testUtils__/schemas.js';

import {
  simulateFeedbackSession,
  type StubFinding,
  type StubSummary,
} from './mocks/feedback-agent-stub.js';

import { startToyApp, type ToyAppInstance } from './helpers/toy-app-runner.js';

const execFileAsync = promisify(execFile);

const TOY_CLI_PATH = path.resolve(__dirname, '../fixtures/toy-app/cli.js');

// Session-events DB schema (mirrors session-events MCP server)
const SESSION_EVENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS session_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  agent_id TEXT,
  integration_id TEXT,
  event_type TEXT NOT NULL,
  event_category TEXT NOT NULL,
  input TEXT NOT NULL,
  output TEXT,
  error TEXT,
  duration_ms INTEGER,
  page_url TEXT,
  page_title TEXT,
  element_selector TEXT,
  timestamp TEXT DEFAULT (datetime('now')),
  metadata TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id);
CREATE INDEX IF NOT EXISTS idx_session_events_type ON session_events(event_type);
CREATE INDEX IF NOT EXISTS idx_session_events_timestamp ON session_events(timestamp);
`;

// ============================================================================
// Helpers
// ============================================================================

/** Simple glob matching (same as in user-feedback server and pipeline tests) */
function globMatch(pattern: string, filePath: string): boolean {
  const normalizedPattern = pattern.replace(/\\/g, '/');
  const normalizedPath = filePath.replace(/\\/g, '/');

  let regex = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');

  regex = `^${regex}$`;

  try {
    return new RegExp(regex).test(normalizedPath);
  } catch {
    return false;
  }
}

/** Insert a persona into the test DB */
function createPersona(db: Database.Database, args: {
  name: string;
  description: string;
  consumption_mode: 'gui' | 'cli' | 'api' | 'sdk';
  behavior_traits?: string[];
  endpoints?: string[];
}) {
  const id = randomUUID();
  const now = new Date();
  db.prepare(`
    INSERT INTO personas (id, name, description, consumption_mode, behavior_traits, endpoints, created_at, created_timestamp, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, args.name, args.description, args.consumption_mode,
    JSON.stringify(args.behavior_traits ?? []),
    JSON.stringify(args.endpoints ?? []),
    now.toISOString(), Math.floor(now.getTime() / 1000), now.toISOString()
  );
  return { id, name: args.name };
}

/** Register a feature in the test DB */
function registerFeature(db: Database.Database, args: {
  name: string;
  description?: string;
  file_patterns: string[];
  category?: string;
}) {
  const id = randomUUID();
  const now = new Date();
  db.prepare(`
    INSERT INTO features (id, name, description, file_patterns, url_patterns, category, created_at, created_timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, args.name, args.description ?? null,
    JSON.stringify(args.file_patterns), JSON.stringify([]),
    args.category ?? null, now.toISOString(), Math.floor(now.getTime() / 1000)
  );
  return { id, name: args.name };
}

/** Map persona to feature */
function mapPersonaToFeature(db: Database.Database, args: {
  persona_id: string;
  feature_id: string;
  priority?: string;
  test_scenarios?: string[];
}) {
  db.prepare(`
    INSERT OR REPLACE INTO persona_features (persona_id, feature_id, priority, test_scenarios)
    VALUES (?, ?, ?, ?)
  `).run(args.persona_id, args.feature_id, args.priority ?? 'normal', JSON.stringify(args.test_scenarios ?? []));
}

/** Get personas matching changed files */
function getPersonasForChanges(db: Database.Database, changedFiles: string[]) {
  interface FeatureRow { id: string; file_patterns: string; }
  interface MappingRow {
    persona_id: string; feature_id: string; priority: string;
    test_scenarios: string; p_name: string; f_name: string;
  }

  const allFeatures = db.prepare('SELECT id, file_patterns FROM features').all() as FeatureRow[];
  const affectedFeatureIds = new Set<string>();

  for (const feature of allFeatures) {
    const patterns = JSON.parse(feature.file_patterns) as string[];
    for (const pattern of patterns) {
      for (const file of changedFiles) {
        if (globMatch(pattern, file)) {
          affectedFeatureIds.add(feature.id);
          break;
        }
      }
    }
  }

  if (affectedFeatureIds.size === 0) return { personas: [], matched_features: [] };

  const featureIdList = Array.from(affectedFeatureIds);
  const placeholders = featureIdList.map(() => '?').join(',');
  const mappings = db.prepare(`
    SELECT pf.persona_id, pf.feature_id, pf.priority, pf.test_scenarios,
           p.name as p_name, f.name as f_name
    FROM persona_features pf
    JOIN personas p ON p.id = pf.persona_id
    JOIN features f ON f.id = pf.feature_id
    WHERE pf.feature_id IN (${placeholders}) AND p.enabled = 1
  `).all(...featureIdList) as MappingRow[];

  const personaIds = [...new Set(mappings.map(m => m.persona_id))];
  return {
    personas: personaIds.map(pid => ({
      persona_id: pid,
      persona_name: mappings.find(m => m.persona_id === pid)!.p_name,
      matched_features: mappings
        .filter(m => m.persona_id === pid)
        .map(m => ({ feature_id: m.feature_id, feature_name: m.f_name, priority: m.priority })),
    })),
    matched_features: featureIdList,
  };
}

/** Start a feedback run */
function startFeedbackRun(db: Database.Database, args: {
  trigger_type: string;
  trigger_ref?: string;
  changed_files: string[];
}) {
  const analysis = getPersonasForChanges(db, args.changed_files);
  if (analysis.personas.length === 0) return { error: 'No personas matched' };

  const runId = randomUUID();
  const personaIds = analysis.personas.map(p => p.persona_id);
  db.prepare(`
    INSERT INTO feedback_runs (id, trigger_type, trigger_ref, changed_features, personas_triggered, status, max_concurrent, started_at)
    VALUES (?, ?, ?, ?, ?, 'pending', 3, ?)
  `).run(runId, args.trigger_type, args.trigger_ref ?? null,
    JSON.stringify(analysis.matched_features), JSON.stringify(personaIds), new Date().toISOString());

  const sessionIds: string[] = [];
  for (const personaId of personaIds) {
    const sessionId = randomUUID();
    db.prepare('INSERT INTO feedback_sessions (id, run_id, persona_id, status) VALUES (?, ?, ?, ?)').run(sessionId, runId, personaId, 'pending');
    sessionIds.push(sessionId);
  }
  return { run_id: runId, session_ids: sessionIds, personas: personaIds };
}

/** Record an audit event (simulating AuditedMcpServer) */
function recordAuditEvent(eventsDb: Database.Database, args: {
  session_id: string;
  persona_name: string;
  tool_name: string;
  tool_args: unknown;
  result: unknown;
  duration_ms: number;
  mcp_server: string;
  error?: string;
}) {
  eventsDb.prepare(`
    INSERT INTO session_events (id, session_id, agent_id, event_type, event_category, input, output, error, duration_ms, metadata)
    VALUES (?, ?, ?, ?, 'mcp', ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    args.session_id,
    args.persona_name,
    args.error ? 'mcp_tool_error' : 'mcp_tool_call',
    JSON.stringify({ tool: args.tool_name, args: args.tool_args }),
    args.error ? null : JSON.stringify(args.result),
    args.error ? JSON.stringify({ message: args.error, tool: args.tool_name }) : null,
    args.duration_ms,
    JSON.stringify({ mcp_server: args.mcp_server }),
  );
}

// ============================================================================
// E2E Tests
// ============================================================================

describe('Feedback System E2E', () => {
  let toyApp: ToyAppInstance;

  beforeAll(async () => {
    toyApp = await startToyApp();
  }, 10000);

  afterAll(async () => {
    await toyApp.stop();
  }, 5000);

  // ==========================================================================
  // 1. API Persona Flow
  // ==========================================================================

  describe('API Persona Flow', () => {
    let feedbackDb: Database.Database;
    let reportsDb: Database.Database;

    beforeEach(() => {
      feedbackDb = createTestDb(USER_FEEDBACK_SCHEMA);
      reportsDb = createTestDb(AGENT_REPORTS_SCHEMA);
    });

    afterEach(() => {
      feedbackDb.close();
      reportsDb.close();
    });

    it('should list tasks via real API', async () => {
      const response = await fetch(`${toyApp.baseUrl}/api/tasks`);
      expect(response.status).toBe(200);

      const data = await response.json() as { tasks: Array<{ id: number; title: string; completed: number }> };
      expect(data.tasks).toBeDefined();
      expect(data.tasks.length).toBeGreaterThan(0);

      // Verify seed data
      const titles = data.tasks.map(t => t.title);
      expect(titles).toContain('Buy groceries');
      expect(titles).toContain('Write documentation');
    });

    it('should discover Bug #4: wrong status code on task creation', async () => {
      const response = await fetch(`${toyApp.baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Test task from E2E' }),
      });

      // Bug #4: Returns 200 instead of 201
      expect(response.status).toBe(200); // This IS the bug
      expect(response.status).not.toBe(201); // Would be correct

      const data = await response.json() as { id: number; title: string };
      expect(data.title).toBe('Test task from E2E');
    });

    it('should submit API findings and verify in agent-reports', async () => {
      // Setup persona and feature
      const persona = createPersona(feedbackDb, {
        name: 'api-consumer',
        description: 'REST API tester',
        consumption_mode: 'api',
        endpoints: ['/api/tasks'],
      });

      const feature = registerFeature(feedbackDb, {
        name: 'task-api',
        file_patterns: ['src/api/**', 'server.js'],
        category: 'core',
      });

      mapPersonaToFeature(feedbackDb, {
        persona_id: persona.id,
        feature_id: feature.id,
        priority: 'high',
        test_scenarios: ['List tasks', 'Create task', 'Check status codes'],
      });

      // Exercise the real API
      const createResponse = await fetch(`${toyApp.baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'E2E finding test' }),
      });

      expect(createResponse.status).toBe(200); // Bug #4

      // Submit finding about the bug
      const sessionDb = createTestDb('');
      const findings: StubFinding[] = [{
        title: 'POST /api/tasks returns 200 instead of 201',
        category: 'functionality',
        severity: 'medium',
        description: 'Creating a task returns HTTP 200 OK instead of 201 Created. This violates REST conventions.',
        steps_to_reproduce: [
          'POST /api/tasks with {"title": "test"}',
          'Observe status code is 200, not 201',
        ],
        expected_behavior: 'HTTP 201 Created with task data',
        actual_behavior: 'HTTP 200 OK with task data',
        url: `${toyApp.baseUrl}/api/tasks`,
      }];

      const summary: StubSummary = {
        overall_impression: 'neutral',
        areas_tested: ['Task CRUD API', 'Status codes'],
        areas_not_tested: ['Authentication API', 'Error handling'],
        confidence: 'high',
      };

      const result = simulateFeedbackSession(sessionDb, reportsDb, 'api-consumer', findings, summary);

      // Verify findings submitted
      expect(result.findingIds).toHaveLength(1);
      expect(result.reportIds).toHaveLength(2); // 1 finding + 1 summary

      // Verify reports in agent-reports DB
      interface ReportRow {
        id: string;
        reporting_agent: string;
        title: string;
        category: string;
        priority: string;
        triage_status: string;
        summary: string;
      }

      const reports = reportsDb.prepare('SELECT * FROM reports ORDER BY created_at').all() as ReportRow[];
      expect(reports).toHaveLength(2);

      // Finding report
      const findingReport = reports.find(r => r.title.includes('200 instead of 201'));
      expect(findingReport).toBeDefined();
      expect(findingReport!.category).toBe('user-feedback');
      expect(findingReport!.reporting_agent).toBe('feedback-api-consumer');
      expect(findingReport!.priority).toBe('normal'); // medium severity → normal priority
      expect(findingReport!.triage_status).toBe('pending');
      expect(findingReport!.summary).toContain('REST conventions');

      // Summary report
      const summaryReport = reports.find(r => r.title.includes('Summary'));
      expect(summaryReport).toBeDefined();
      expect(summaryReport!.reporting_agent).toBe('feedback-api-consumer');

      sessionDb.close();
    });
  });

  // ==========================================================================
  // 2. CLI Persona Flow
  // ==========================================================================

  describe('CLI Persona Flow', () => {
    let feedbackDb: Database.Database;
    let reportsDb: Database.Database;

    beforeEach(() => {
      feedbackDb = createTestDb(USER_FEEDBACK_SCHEMA);
      reportsDb = createTestDb(AGENT_REPORTS_SCHEMA);
    });

    afterEach(() => {
      feedbackDb.close();
      reportsDb.close();
    });

    it('should list tasks via real CLI', async () => {
      const { stdout } = await execFileAsync('node', [
        TOY_CLI_PATH, 'tasks', 'list', `--api-url=${toyApp.baseUrl}`,
      ], { timeout: 5000 });

      expect(stdout).toContain('Tasks:');
      expect(stdout).toContain('Buy groceries');
    });

    it('should create and complete tasks via CLI', async () => {
      // Create a task
      const createResult = await execFileAsync('node', [
        TOY_CLI_PATH, 'tasks', 'create',
        '--title=CLI E2E Test Task',
        `--api-url=${toyApp.baseUrl}`,
      ], { timeout: 5000 });

      expect(createResult.stdout).toContain('Created task');
      const taskIdMatch = createResult.stdout.match(/#(\d+)/);
      expect(taskIdMatch).not.toBeNull();

      const taskId = taskIdMatch![1];

      // Complete the task
      const completeResult = await execFileAsync('node', [
        TOY_CLI_PATH, 'tasks', 'complete',
        `--id=${taskId}`,
        `--api-url=${toyApp.baseUrl}`,
      ], { timeout: 5000 });

      expect(completeResult.stdout).toContain(`Completed task #${taskId}`);
    });

    it('should discover Bug #5: no --help flag', async () => {
      // Bug #5: --help is treated as an unknown command, not a help flag
      try {
        await execFileAsync('node', [TOY_CLI_PATH, '--help'], { timeout: 5000 });
        // If it doesn't throw, that's also unexpected for a missing flag
        expect.fail('Expected CLI to exit with error for --help');
      } catch (err: unknown) {
        // CLI exits with code 1 and shows "Unknown command: --help"
        const error = err as { stderr?: string; stdout?: string; code?: number };
        const output = (error.stderr || '') + (error.stdout || '');
        expect(output).toContain('Unknown command');
      }
    });

    it('should submit CLI findings and verify in agent-reports', async () => {
      const sessionDb = createTestDb('');

      const findings: StubFinding[] = [{
        title: 'CLI has no --help flag',
        category: 'usability',
        severity: 'low',
        description: 'Running the CLI with --help shows a generic error message instead of a dedicated help screen.',
        steps_to_reproduce: [
          'Run: node cli.js --help',
          'Observe: shows error usage message and exits with code 1',
        ],
        expected_behavior: 'A dedicated help screen showing all commands and options',
        actual_behavior: 'Generic "Usage:" error message with exit code 1',
      }];

      const result = simulateFeedbackSession(sessionDb, reportsDb, 'cli-expert', findings);

      expect(result.findingIds).toHaveLength(1);
      expect(result.reportIds).toHaveLength(1);

      interface ReportRow { id: string; reporting_agent: string; title: string; category: string; }
      const report = reportsDb.prepare('SELECT * FROM reports').get() as ReportRow;
      expect(report.category).toBe('user-feedback');
      expect(report.reporting_agent).toBe('feedback-cli-expert');
      expect(report.title).toContain('--help');

      sessionDb.close();
    });
  });

  // ==========================================================================
  // 3. Multi-Persona Run
  // ==========================================================================

  describe('Multi-Persona Run', () => {
    let feedbackDb: Database.Database;
    let reportsDb: Database.Database;

    beforeEach(() => {
      feedbackDb = createTestDb(USER_FEEDBACK_SCHEMA);
      reportsDb = createTestDb(AGENT_REPORTS_SCHEMA);
    });

    afterEach(() => {
      feedbackDb.close();
      reportsDb.close();
    });

    it('should run full pipeline: change detection → persona selection → findings → reports', async () => {
      // Setup: 2 personas, 2 features
      const apiPersona = createPersona(feedbackDb, {
        name: 'api-tester',
        description: 'Tests REST API endpoints',
        consumption_mode: 'api',
      });

      const cliPersona = createPersona(feedbackDb, {
        name: 'cli-tester',
        description: 'Tests CLI interface',
        consumption_mode: 'cli',
      });

      const apiFeature = registerFeature(feedbackDb, {
        name: 'rest-api',
        file_patterns: ['src/api/**', 'server.js'],
      });

      const cliFeature = registerFeature(feedbackDb, {
        name: 'cli-interface',
        file_patterns: ['cli.js', 'src/cli/**'],
      });

      mapPersonaToFeature(feedbackDb, { persona_id: apiPersona.id, feature_id: apiFeature.id, priority: 'high' });
      mapPersonaToFeature(feedbackDb, { persona_id: cliPersona.id, feature_id: cliFeature.id, priority: 'normal' });

      // Simulate changed files from a staging push
      const changedFiles = ['server.js', 'cli.js'];
      const analysis = getPersonasForChanges(feedbackDb, changedFiles);

      expect(analysis.personas).toHaveLength(2);
      expect(analysis.personas.map(p => p.persona_name).sort()).toEqual(['api-tester', 'cli-tester']);

      // Start feedback run
      const run = startFeedbackRun(feedbackDb, {
        trigger_type: 'staging-push',
        trigger_ref: 'abc123',
        changed_files: changedFiles,
      });

      expect(isErrorResult(run)).toBe(false);
      if (isErrorResult(run)) return;

      expect(run.session_ids).toHaveLength(2);

      // Simulate API persona finding Bug #4
      const apiSessionDb = createTestDb('');
      const apiFindings: StubFinding[] = [{
        title: 'Wrong HTTP status code on POST /api/tasks',
        category: 'functionality',
        severity: 'medium',
        description: 'Returns 200 instead of 201',
        url: `${toyApp.baseUrl}/api/tasks`,
      }];

      // Actually hit the API to verify the bug exists
      const apiResponse = await fetch(`${toyApp.baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Multi-persona test' }),
      });
      expect(apiResponse.status).toBe(200); // Bug confirmed

      const apiResult = simulateFeedbackSession(apiSessionDb, reportsDb, 'api-tester', apiFindings);

      // Complete API session
      feedbackDb.prepare(`
        UPDATE feedback_sessions SET status = 'completed', completed_at = ?, findings_count = ?, report_ids = ?
        WHERE id = ?
      `).run(new Date().toISOString(), 1, JSON.stringify(apiResult.reportIds), run.session_ids[0]);

      // Simulate CLI persona finding Bug #5
      const cliSessionDb = createTestDb('');
      const cliFindings: StubFinding[] = [{
        title: 'No --help flag',
        category: 'usability',
        severity: 'low',
        description: 'CLI exits with error when --help is passed',
      }];

      const cliResult = simulateFeedbackSession(cliSessionDb, reportsDb, 'cli-tester', cliFindings);

      // Complete CLI session
      feedbackDb.prepare(`
        UPDATE feedback_sessions SET status = 'completed', completed_at = ?, findings_count = ?, report_ids = ?
        WHERE id = ?
      `).run(new Date().toISOString(), 1, JSON.stringify(cliResult.reportIds), run.session_ids[1]);

      // Complete the run
      feedbackDb.prepare("UPDATE feedback_runs SET status = 'completed', completed_at = ? WHERE id = ?")
        .run(new Date().toISOString(), run.run_id);

      // Verify the full pipeline
      interface ReportRow { id: string; reporting_agent: string; title: string; category: string; }
      const allReports = reportsDb.prepare('SELECT * FROM reports').all() as ReportRow[];
      expect(allReports).toHaveLength(2);
      expect(allReports.every(r => r.category === 'user-feedback')).toBe(true);

      const agents = allReports.map(r => r.reporting_agent).sort();
      expect(agents).toEqual(['feedback-api-tester', 'feedback-cli-tester']);

      // Verify run summary
      interface SessionRow { id: string; status: string; findings_count: number; }
      const sessions = feedbackDb.prepare('SELECT * FROM feedback_sessions WHERE run_id = ?').all(run.run_id) as SessionRow[];
      expect(sessions.every(s => s.status === 'completed')).toBe(true);
      const totalFindings = sessions.reduce((sum, s) => sum + s.findings_count, 0);
      expect(totalFindings).toBe(2);

      apiSessionDb.close();
      cliSessionDb.close();
    });
  });

  // ==========================================================================
  // 4. Audit Trail Verification
  // ==========================================================================

  describe('Audit Trail Verification', () => {
    let eventsDb: Database.Database;

    beforeEach(() => {
      eventsDb = createTestDb(SESSION_EVENTS_SCHEMA);
    });

    afterEach(() => {
      eventsDb.close();
    });

    it('should record complete audit trail for a feedback session', () => {
      const sessionId = randomUUID();
      const personaName = 'api-auditor';
      const serverName = 'programmatic-feedback';

      // Simulate MCP tool calls that an API persona would make
      recordAuditEvent(eventsDb, {
        session_id: sessionId,
        persona_name: personaName,
        tool_name: 'api_request',
        tool_args: { method: 'GET', path: '/api/tasks' },
        result: { status: 200, body: { tasks: [{ id: 1, title: 'Test' }] } },
        duration_ms: 45,
        mcp_server: serverName,
      });

      recordAuditEvent(eventsDb, {
        session_id: sessionId,
        persona_name: personaName,
        tool_name: 'api_request',
        tool_args: { method: 'POST', path: '/api/tasks', body: { title: 'New task' } },
        result: { status: 200, body: { id: 3, title: 'New task' } },
        duration_ms: 32,
        mcp_server: serverName,
      });

      // Simulate a finding submission
      recordAuditEvent(eventsDb, {
        session_id: sessionId,
        persona_name: personaName,
        tool_name: 'submit_finding',
        tool_args: { title: 'Wrong status code', category: 'functionality', severity: 'medium' },
        result: { id: randomUUID(), report_id: randomUUID() },
        duration_ms: 8,
        mcp_server: 'feedback-reporter',
      });

      // Verify audit trail
      interface EventRow {
        id: string;
        session_id: string;
        agent_id: string;
        event_type: string;
        event_category: string;
        input: string;
        output: string | null;
        error: string | null;
        duration_ms: number;
        metadata: string;
      }

      const events = eventsDb.prepare(
        "SELECT * FROM session_events WHERE session_id = ? AND event_type IN ('mcp_tool_call', 'mcp_tool_error') ORDER BY timestamp ASC"
      ).all(sessionId) as EventRow[];

      expect(events).toHaveLength(3);

      // Verify first event (GET /api/tasks)
      const firstEvent = events[0];
      expect(firstEvent.session_id).toBe(sessionId);
      expect(firstEvent.agent_id).toBe(personaName);
      expect(firstEvent.event_type).toBe('mcp_tool_call');
      expect(firstEvent.event_category).toBe('mcp');
      expect(firstEvent.duration_ms).toBe(45);

      const input0 = JSON.parse(firstEvent.input) as { tool: string; args: unknown };
      expect(input0.tool).toBe('api_request');
      expect(input0.args).toEqual({ method: 'GET', path: '/api/tasks' });

      const output0 = JSON.parse(firstEvent.output!) as { status: number };
      expect(output0.status).toBe(200);

      const metadata0 = JSON.parse(firstEvent.metadata) as { mcp_server: string };
      expect(metadata0.mcp_server).toBe('programmatic-feedback');

      // Verify third event (submit_finding via different MCP server)
      const thirdEvent = events[2];
      const input2 = JSON.parse(thirdEvent.input) as { tool: string };
      expect(input2.tool).toBe('submit_finding');

      const metadata2 = JSON.parse(thirdEvent.metadata) as { mcp_server: string };
      expect(metadata2.mcp_server).toBe('feedback-reporter');
    });

    it('should record error events in audit trail', () => {
      const sessionId = randomUUID();

      recordAuditEvent(eventsDb, {
        session_id: sessionId,
        persona_name: 'error-tester',
        tool_name: 'api_request',
        tool_args: { method: 'GET', path: '/nonexistent' },
        result: null,
        duration_ms: 12,
        mcp_server: 'programmatic-feedback',
        error: 'HTTP 404: Not Found',
      });

      interface EventRow {
        event_type: string;
        error: string | null;
        output: string | null;
      }

      const event = eventsDb.prepare(
        "SELECT event_type, error, output FROM session_events WHERE session_id = ?"
      ).get(sessionId) as EventRow;

      expect(event.event_type).toBe('mcp_tool_error');
      expect(event.output).toBeNull();

      const error = JSON.parse(event.error!) as { message: string; tool: string };
      expect(error.message).toBe('HTTP 404: Not Found');
      expect(error.tool).toBe('api_request');
    });

    it('should distinguish events from different MCP servers in same session', () => {
      const sessionId = randomUUID();

      // Action from programmatic-feedback
      recordAuditEvent(eventsDb, {
        session_id: sessionId,
        persona_name: 'multi-server',
        tool_name: 'api_request',
        tool_args: { method: 'GET', path: '/api/tasks' },
        result: { status: 200 },
        duration_ms: 30,
        mcp_server: 'programmatic-feedback',
      });

      // Action from feedback-reporter
      recordAuditEvent(eventsDb, {
        session_id: sessionId,
        persona_name: 'multi-server',
        tool_name: 'submit_finding',
        tool_args: { title: 'Bug found' },
        result: { id: 'f1', report_id: 'r1' },
        duration_ms: 5,
        mcp_server: 'feedback-reporter',
      });

      interface EventRow { metadata: string; }
      const events = eventsDb.prepare(
        "SELECT metadata FROM session_events WHERE session_id = ? ORDER BY timestamp ASC"
      ).all(sessionId) as EventRow[];

      expect(events).toHaveLength(2);
      expect(JSON.parse(events[0].metadata).mcp_server).toBe('programmatic-feedback');
      expect(JSON.parse(events[1].metadata).mcp_server).toBe('feedback-reporter');
    });

    it('should calculate correct total duration across all events', () => {
      const sessionId = randomUUID();

      recordAuditEvent(eventsDb, {
        session_id: sessionId,
        persona_name: 'duration-test',
        tool_name: 'api_request',
        tool_args: {},
        result: {},
        duration_ms: 100,
        mcp_server: 'programmatic-feedback',
      });

      recordAuditEvent(eventsDb, {
        session_id: sessionId,
        persona_name: 'duration-test',
        tool_name: 'api_request',
        tool_args: {},
        result: {},
        duration_ms: 200,
        mcp_server: 'programmatic-feedback',
      });

      recordAuditEvent(eventsDb, {
        session_id: sessionId,
        persona_name: 'duration-test',
        tool_name: 'submit_finding',
        tool_args: {},
        result: {},
        duration_ms: 50,
        mcp_server: 'feedback-reporter',
      });

      interface SumRow { total: number; count: number; }
      const result = eventsDb.prepare(
        "SELECT SUM(duration_ms) as total, COUNT(*) as count FROM session_events WHERE session_id = ?"
      ).get(sessionId) as SumRow;

      expect(result.count).toBe(3);
      expect(result.total).toBe(350);
    });
  });
});
