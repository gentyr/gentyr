/**
 * Unit tests for Feedback Explorer MCP Server
 *
 * Tests all 7 tools:
 * - list_feedback_personas
 * - get_persona_details
 * - list_persona_sessions
 * - get_session_details
 * - list_persona_reports
 * - get_report_details
 * - get_feedback_overview
 *
 * Covers database reads, per-session DB access, and satisfaction level handling.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { createTestDb, isErrorResult } from '../../__testUtils__/index.js';
import { createFeedbackExplorerServer } from '../server.js';
import type { FeedbackExplorerConfig } from '../server.js';
import type {
  ListFeedbackPersonasResult,
  PersonaDetails,
  ListPersonaSessionsResult,
  GetSessionDetailsResult,
  ListPersonaReportsResult,
  ReportDetails,
  GetFeedbackOverviewResult,
  ErrorResult,
} from '../types.js';

// ============================================================================
// Database Schemas
// ============================================================================

const USER_FEEDBACK_SCHEMA = `
CREATE TABLE IF NOT EXISTS personas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  consumption_mode TEXT NOT NULL CHECK (consumption_mode IN ('gui', 'cli', 'api', 'sdk', 'adk')),
  behavior_traits TEXT NOT NULL DEFAULT '[]',
  endpoints TEXT NOT NULL DEFAULT '[]',
  credentials_ref TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  created_timestamp INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS features (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  file_patterns TEXT NOT NULL DEFAULT '[]',
  url_patterns TEXT NOT NULL DEFAULT '[]',
  category TEXT,
  created_at TEXT NOT NULL,
  created_timestamp INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS persona_features (
  persona_id TEXT NOT NULL REFERENCES personas(id),
  feature_id TEXT NOT NULL REFERENCES features(id),
  priority TEXT NOT NULL DEFAULT 'normal',
  test_scenarios TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (persona_id, feature_id)
);

CREATE TABLE IF NOT EXISTS feedback_runs (
  id TEXT PRIMARY KEY,
  trigger_type TEXT NOT NULL,
  trigger_ref TEXT,
  changed_features TEXT NOT NULL DEFAULT '[]',
  personas_triggered TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  max_concurrent INTEGER NOT NULL DEFAULT 3,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  summary TEXT
);

CREATE TABLE IF NOT EXISTS feedback_sessions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES feedback_runs(id),
  persona_id TEXT NOT NULL REFERENCES personas(id),
  agent_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  started_at TEXT,
  completed_at TEXT,
  findings_count INTEGER NOT NULL DEFAULT 0,
  report_ids TEXT NOT NULL DEFAULT '[]',
  satisfaction_level TEXT
);
`;

const CTO_REPORTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  reporting_agent TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  priority TEXT NOT NULL DEFAULT 'normal',
  created_at TEXT NOT NULL,
  created_timestamp INTEGER NOT NULL,
  read_at TEXT,
  acknowledged_at TEXT,
  triage_status TEXT DEFAULT 'pending',
  triage_started_at TEXT,
  triage_completed_at TEXT,
  triage_session_id TEXT,
  triage_outcome TEXT,
  triage_attempted_at TEXT,
  triaged_at TEXT,
  triage_action TEXT
);
`;

const SESSION_EVENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  input TEXT,
  output TEXT,
  error TEXT,
  duration_ms INTEGER,
  metadata TEXT
);
`;

const SESSION_DB_SCHEMA = `
CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  description TEXT NOT NULL,
  steps_to_reproduce TEXT NOT NULL DEFAULT '[]',
  expected_behavior TEXT,
  actual_behavior TEXT,
  screenshot_ref TEXT,
  url TEXT,
  report_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_summary (
  id TEXT PRIMARY KEY DEFAULT 'summary',
  overall_impression TEXT NOT NULL,
  areas_tested TEXT NOT NULL DEFAULT '[]',
  areas_not_tested TEXT NOT NULL DEFAULT '[]',
  confidence TEXT NOT NULL,
  summary_notes TEXT,
  satisfaction_level TEXT,
  created_at TEXT NOT NULL
);
`;

// ============================================================================
// Helper Functions
// ============================================================================

function createPersona(db: Database.Database, data: {
  id?: string;
  name: string;
  description: string;
  consumption_mode: string;
  behavior_traits?: string[];
  endpoints?: string[];
  enabled?: boolean;
}) {
  const id = data.id || randomUUID();
  const now = new Date();
  const created_at = now.toISOString();
  const created_timestamp = Math.floor(now.getTime() / 1000);

  db.prepare(`
    INSERT INTO personas (id, name, description, consumption_mode, behavior_traits, endpoints, enabled, created_at, created_timestamp, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    data.name,
    data.description,
    data.consumption_mode,
    JSON.stringify(data.behavior_traits ?? []),
    JSON.stringify(data.endpoints ?? []),
    data.enabled === false ? 0 : 1,
    created_at,
    created_timestamp,
    created_at
  );

  return id;
}

function createFeature(db: Database.Database, data: {
  id?: string;
  name: string;
  file_patterns: string[];
}) {
  const id = data.id || randomUUID();
  const now = new Date();

  db.prepare(`
    INSERT INTO features (id, name, file_patterns, created_at, created_timestamp)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    id,
    data.name,
    JSON.stringify(data.file_patterns),
    now.toISOString(),
    Math.floor(now.getTime() / 1000)
  );

  return id;
}

function mapPersonaToFeature(db: Database.Database, data: {
  persona_id: string;
  feature_id: string;
  priority?: string;
  test_scenarios?: string[];
}) {
  db.prepare(`
    INSERT INTO persona_features (persona_id, feature_id, priority, test_scenarios)
    VALUES (?, ?, ?, ?)
  `).run(
    data.persona_id,
    data.feature_id,
    data.priority ?? 'normal',
    JSON.stringify(data.test_scenarios ?? [])
  );
}

function createRun(db: Database.Database, data: {
  id?: string;
  trigger_type?: string;
}) {
  const id = data.id || randomUUID();
  db.prepare(`
    INSERT INTO feedback_runs (id, trigger_type, changed_features, personas_triggered, status, max_concurrent, started_at)
    VALUES (?, ?, '[]', '[]', 'pending', 3, ?)
  `).run(id, data.trigger_type ?? 'manual', new Date().toISOString());
  return id;
}

function createSession(db: Database.Database, data: {
  id?: string;
  run_id: string;
  persona_id: string;
  status?: string;
  started_at?: string | null;
  completed_at?: string | null;
  findings_count?: number;
  satisfaction_level?: string | null;
}) {
  const id = data.id || randomUUID();

  db.prepare(`
    INSERT INTO feedback_sessions (id, run_id, persona_id, status, started_at, completed_at, findings_count, satisfaction_level)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    data.run_id,
    data.persona_id,
    data.status ?? 'pending',
    data.started_at ?? null,
    data.completed_at ?? null,
    data.findings_count ?? 0,
    data.satisfaction_level ?? null
  );

  return id;
}

function createReport(db: Database.Database, data: {
  id?: string;
  reporting_agent: string;
  title: string;
  summary: string;
  category?: string;
  priority?: string;
  triage_status?: string;
  triage_outcome?: string | null;
}) {
  const id = data.id || randomUUID();
  const now = new Date();

  db.prepare(`
    INSERT INTO reports (id, reporting_agent, title, summary, category, priority, created_at, created_timestamp, triage_status, triage_outcome)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    data.reporting_agent,
    data.title,
    data.summary,
    data.category ?? 'user-feedback',
    data.priority ?? 'normal',
    now.toISOString(),
    Math.floor(now.getTime() / 1000),
    data.triage_status ?? 'pending',
    data.triage_outcome ?? null
  );

  return id;
}

function callTool<T>(server: ReturnType<typeof createFeedbackExplorerServer>, toolName: string, args: unknown): T {
  // Access the private tools Map via prototype chain
  const toolsMap = (server as unknown as { tools: Map<string, { handler: (args: unknown) => unknown }> }).tools;
  const tool = toolsMap.get(toolName);
  if (!tool) {
    throw new Error(`Tool not found: ${toolName}`);
  }
  return tool.handler(args) as T;
}

// ============================================================================
// Tests
// ============================================================================

describe('Feedback Explorer MCP Server', () => {
  let userFeedbackDb: Database.Database;
  let ctoReportsDb: Database.Database;
  let sessionEventsDb: Database.Database;
  let tempDir: string;
  let projectDir: string;

  beforeEach(() => {
    userFeedbackDb = createTestDb(USER_FEEDBACK_SCHEMA);
    ctoReportsDb = createTestDb(CTO_REPORTS_SCHEMA);
    sessionEventsDb = createTestDb(SESSION_EVENTS_SCHEMA);

    // Create temp directory for per-session DBs
    tempDir = path.join(os.tmpdir(), `feedback-explorer-test-${randomUUID()}`);
    projectDir = tempDir;
    fs.mkdirSync(path.join(tempDir, '.claude', 'feedback-sessions'), { recursive: true });
  });

  afterEach(() => {
    userFeedbackDb.close();
    ctoReportsDb.close();
    sessionEventsDb.close();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ==========================================================================
  // list_feedback_personas Tests
  // ==========================================================================

  describe('list_feedback_personas', () => {
    it('should return all personas with session counts, findings counts, and latest satisfaction', () => {
      const config: FeedbackExplorerConfig = { projectDir, userFeedbackDb, ctoReportsDb, sessionEventsDb };
      const server = createFeedbackExplorerServer(config);

      const persona1Id = createPersona(userFeedbackDb, {
        name: 'power-user',
        description: 'Experienced user',
        consumption_mode: 'gui',
      });

      const persona2Id = createPersona(userFeedbackDb, {
        name: 'api-dev',
        description: 'API developer',
        consumption_mode: 'api',
      });

      const runId = createRun(userFeedbackDb, {});
      createSession(userFeedbackDb, {
        run_id: runId,
        persona_id: persona1Id,
        findings_count: 5,
        satisfaction_level: 'satisfied',
        completed_at: '2026-01-01T00:00:00.000Z',
      });

      createSession(userFeedbackDb, {
        run_id: runId,
        persona_id: persona1Id,
        findings_count: 3,
        satisfaction_level: 'very_satisfied',
        completed_at: '2026-01-02T00:00:00.000Z',
      });

      const result = callTool<ListFeedbackPersonasResult>(server, 'list_feedback_personas', {});

      expect(result.total).toBe(2);
      expect(result.personas).toHaveLength(2);

      const powerUser = result.personas.find(p => p.name === 'power-user')!;
      expect(powerUser.session_count).toBe(2);
      expect(powerUser.findings_count).toBe(8);
      expect(powerUser.latest_satisfaction).toBe('very_satisfied');
      expect(powerUser.enabled).toBe(true);

      const apiDev = result.personas.find(p => p.name === 'api-dev')!;
      expect(apiDev.session_count).toBe(0);
      expect(apiDev.findings_count).toBe(0);
      expect(apiDev.latest_satisfaction).toBeNull();
    });

    it('should filter by enabled_only', () => {
      const config: FeedbackExplorerConfig = { projectDir, userFeedbackDb, ctoReportsDb, sessionEventsDb };
      const server = createFeedbackExplorerServer(config);

      createPersona(userFeedbackDb, { name: 'enabled-user', description: 'Enabled', consumption_mode: 'gui' });
      createPersona(userFeedbackDb, { name: 'disabled-user', description: 'Disabled', consumption_mode: 'gui', enabled: false });

      const result = callTool<ListFeedbackPersonasResult>(server, 'list_feedback_personas', { enabled_only: true });

      expect(result.total).toBe(1);
      expect(result.personas[0].name).toBe('enabled-user');
    });

    it('should filter by consumption_mode', () => {
      const config: FeedbackExplorerConfig = { projectDir, userFeedbackDb, ctoReportsDb, sessionEventsDb };
      const server = createFeedbackExplorerServer(config);

      createPersona(userFeedbackDb, { name: 'gui-user', description: 'GUI', consumption_mode: 'gui' });
      createPersona(userFeedbackDb, { name: 'cli-user', description: 'CLI', consumption_mode: 'cli' });
      createPersona(userFeedbackDb, { name: 'api-user', description: 'API', consumption_mode: 'api' });

      const result = callTool<ListFeedbackPersonasResult>(server, 'list_feedback_personas', { consumption_mode: 'gui' });

      expect(result.total).toBe(1);
      expect(result.personas[0].name).toBe('gui-user');
    });
  });

  // ==========================================================================
  // get_persona_details Tests
  // ==========================================================================

  describe('get_persona_details', () => {
    it('should return full persona details with features, recent sessions, and satisfaction history', () => {
      const config: FeedbackExplorerConfig = { projectDir, userFeedbackDb, ctoReportsDb, sessionEventsDb };
      const server = createFeedbackExplorerServer(config);

      const personaId = createPersona(userFeedbackDb, {
        name: 'test-persona',
        description: 'Test description',
        consumption_mode: 'api',
        behavior_traits: ['impatient', 'thorough'],
        endpoints: ['/api/v1/tasks'],
      });

      const feature1Id = createFeature(userFeedbackDb, { name: 'auth', file_patterns: ['src/auth/**'] });
      const feature2Id = createFeature(userFeedbackDb, { name: 'billing', file_patterns: ['src/billing/**'] });

      mapPersonaToFeature(userFeedbackDb, {
        persona_id: personaId,
        feature_id: feature1Id,
        priority: 'critical',
        test_scenarios: ['Login flow', 'Password reset'],
      });

      mapPersonaToFeature(userFeedbackDb, {
        persona_id: personaId,
        feature_id: feature2Id,
        priority: 'high',
        test_scenarios: ['Create subscription'],
      });

      const runId = createRun(userFeedbackDb, {});
      const now = new Date();

      createSession(userFeedbackDb, {
        run_id: runId,
        persona_id: personaId,
        status: 'completed',
        started_at: new Date(now.getTime() - 3600000).toISOString(),
        completed_at: now.toISOString(),
        findings_count: 5,
        satisfaction_level: 'satisfied',
      });

      createSession(userFeedbackDb, {
        run_id: runId,
        persona_id: personaId,
        status: 'completed',
        started_at: new Date(now.getTime() - 7200000).toISOString(),
        completed_at: new Date(now.getTime() - 3600000).toISOString(),
        findings_count: 2,
        satisfaction_level: 'very_satisfied',
      });

      const result = callTool<PersonaDetails>(server, 'get_persona_details', { persona_id: personaId });

      expect(result.name).toBe('test-persona');
      expect(result.description).toBe('Test description');
      expect(result.consumption_mode).toBe('api');
      expect(result.behavior_traits).toEqual(['impatient', 'thorough']);
      expect(result.endpoints).toEqual(['/api/v1/tasks']);
      expect(result.enabled).toBe(true);

      expect(result.features).toHaveLength(2);
      expect(result.features[0].feature_name).toBe('auth');
      expect(result.features[0].priority).toBe('critical');
      expect(result.features[0].test_scenarios).toEqual(['Login flow', 'Password reset']);

      expect(result.recent_sessions).toHaveLength(2);
      expect(result.recent_sessions[0].status).toBe('completed');
      expect(result.recent_sessions[0].findings_count).toBe(5);

      expect(result.satisfaction_history).toHaveLength(2);
      expect(result.satisfaction_history[0].satisfaction_level).toBe('satisfied');
      expect(result.satisfaction_history[1].satisfaction_level).toBe('very_satisfied');
    });

    it('should return error for unknown persona ID', () => {
      const config: FeedbackExplorerConfig = { projectDir, userFeedbackDb, ctoReportsDb, sessionEventsDb };
      const server = createFeedbackExplorerServer(config);

      const result = callTool<PersonaDetails | ErrorResult>(server, 'get_persona_details', { persona_id: 'nonexistent-id' });

      expect(isErrorResult(result)).toBe(true);
      if (isErrorResult(result)) {
        expect(result.error).toContain('not found');
      }
    });
  });

  // ==========================================================================
  // list_persona_sessions Tests
  // ==========================================================================

  describe('list_persona_sessions', () => {
    it('should return paginated sessions with satisfaction', () => {
      const config: FeedbackExplorerConfig = { projectDir, userFeedbackDb, ctoReportsDb, sessionEventsDb };
      const server = createFeedbackExplorerServer(config);

      const personaId = createPersona(userFeedbackDb, { name: 'test-user', description: 'Test', consumption_mode: 'gui' });
      const runId = createRun(userFeedbackDb, {});

      for (let i = 0; i < 10; i++) {
        createSession(userFeedbackDb, {
          run_id: runId,
          persona_id: personaId,
          findings_count: i,
          satisfaction_level: i % 2 === 0 ? 'satisfied' : 'neutral',
        });
      }

      const result = callTool<ListPersonaSessionsResult>(server, 'list_persona_sessions', {
        persona_id: personaId,
        limit: 5,
        offset: 0,
      });

      expect(result.sessions).toHaveLength(5);
      expect(result.total).toBe(5);
    });

    it('should handle pagination with offset', () => {
      const config: FeedbackExplorerConfig = { projectDir, userFeedbackDb, ctoReportsDb, sessionEventsDb };
      const server = createFeedbackExplorerServer(config);

      const personaId = createPersona(userFeedbackDb, { name: 'test-user', description: 'Test', consumption_mode: 'gui' });
      const runId = createRun(userFeedbackDb, {});

      for (let i = 0; i < 15; i++) {
        createSession(userFeedbackDb, {
          run_id: runId,
          persona_id: personaId,
          findings_count: i,
        });
      }

      const page1 = callTool<ListPersonaSessionsResult>(server, 'list_persona_sessions', {
        persona_id: personaId,
        limit: 5,
        offset: 0,
      });

      const page2 = callTool<ListPersonaSessionsResult>(server, 'list_persona_sessions', {
        persona_id: personaId,
        limit: 5,
        offset: 5,
      });

      expect(page1.sessions).toHaveLength(5);
      expect(page2.sessions).toHaveLength(5);

      // Verify different sessions
      expect(page1.sessions[0].id).not.toBe(page2.sessions[0].id);
    });
  });

  // ==========================================================================
  // get_session_details Tests
  // ==========================================================================

  describe('get_session_details', () => {
    it('should return findings and summary from per-session DB', () => {
      const config: FeedbackExplorerConfig = { projectDir, userFeedbackDb, ctoReportsDb, sessionEventsDb };
      const server = createFeedbackExplorerServer(config);

      const personaId = createPersona(userFeedbackDb, { name: 'test-user', description: 'Test', consumption_mode: 'gui' });
      const runId = createRun(userFeedbackDb, {});
      const sessionId = createSession(userFeedbackDb, {
        run_id: runId,
        persona_id: personaId,
        status: 'completed',
      });

      // Create per-session DB
      const sessionDbPath = path.join(tempDir, '.claude', 'feedback-sessions', `${sessionId}.db`);
      const sessionDb = new Database(sessionDbPath);
      sessionDb.exec(SESSION_DB_SCHEMA);

      // Insert findings
      sessionDb.prepare(`
        INSERT INTO findings (id, title, category, severity, description, steps_to_reproduce, expected_behavior, actual_behavior, url, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        'Button not working',
        'functionality',
        'high',
        'Submit button does not respond',
        JSON.stringify(['Navigate to page', 'Click submit']),
        'Form submits',
        'Nothing happens',
        'https://example.com',
        new Date().toISOString()
      );

      // Insert summary
      sessionDb.prepare(`
        INSERT INTO session_summary (id, overall_impression, areas_tested, areas_not_tested, confidence, summary_notes, satisfaction_level, created_at)
        VALUES ('summary', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'negative',
        JSON.stringify(['Login', 'Checkout']),
        JSON.stringify(['Admin panel']),
        'high',
        'Found critical issues',
        'dissatisfied',
        new Date().toISOString()
      );

      sessionDb.close();

      const result = callTool<GetSessionDetailsResult>(server, 'get_session_details', { session_id: sessionId });

      expect(result.session_id).toBe(sessionId);
      expect(result.persona_name).toBe('test-user');
      expect(result.status).toBe('completed');

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].title).toBe('Button not working');
      expect(result.findings[0].severity).toBe('high');
      expect(result.findings[0].steps_to_reproduce).toEqual(['Navigate to page', 'Click submit']);
      expect(result.findings[0].expected_behavior).toBe('Form submits');
      expect(result.findings[0].actual_behavior).toBe('Nothing happens');
      expect(result.findings[0].url).toBe('https://example.com');

      expect(result.summary).not.toBeNull();
      expect(result.summary!.overall_impression).toBe('negative');
      expect(result.summary!.areas_tested).toEqual(['Login', 'Checkout']);
      expect(result.summary!.areas_not_tested).toEqual(['Admin panel']);
      expect(result.summary!.confidence).toBe('high');
      expect(result.summary!.summary_notes).toBe('Found critical issues');
      expect(result.summary!.satisfaction_level).toBe('dissatisfied');
    });

    it('should include audit trail when requested', () => {
      const config: FeedbackExplorerConfig = { projectDir, userFeedbackDb, ctoReportsDb, sessionEventsDb };
      const server = createFeedbackExplorerServer(config);

      const personaId = createPersona(userFeedbackDb, { name: 'test-user', description: 'Test', consumption_mode: 'api' });
      const runId = createRun(userFeedbackDb, {});
      const sessionId = createSession(userFeedbackDb, {
        run_id: runId,
        persona_id: personaId,
      });

      // Create per-session DB (required since openSessionDb throws on missing)
      const sessionDbPath = path.join(tempDir, '.claude', 'feedback-sessions', `${sessionId}.db`);
      const sessionDb = new Database(sessionDbPath);
      sessionDb.exec(SESSION_DB_SCHEMA);
      sessionDb.close();

      // Insert session events
      sessionEventsDb.prepare(`
        INSERT INTO session_events (session_id, event_type, timestamp, input, output, duration_ms, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        sessionId,
        'mcp_tool_call',
        new Date().toISOString(),
        JSON.stringify({ tool: 'api_request', args: { method: 'GET', path: '/tasks' } }),
        JSON.stringify({ status: 200, body: [] }),
        45,
        JSON.stringify({ mcp_server: 'programmatic-feedback' })
      );

      sessionEventsDb.prepare(`
        INSERT INTO session_events (session_id, event_type, timestamp, input, output, duration_ms, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        sessionId,
        'mcp_tool_call',
        new Date().toISOString(),
        JSON.stringify({ tool: 'submit_finding', args: { title: 'Bug' } }),
        JSON.stringify({ id: 'finding-1' }),
        12,
        JSON.stringify({ mcp_server: 'feedback-reporter' })
      );

      const result = callTool<GetSessionDetailsResult>(server, 'get_session_details', {
        session_id: sessionId,
        include_audit: true,
      });

      expect(result.audit_trail).toBeDefined();
      expect(result.audit_trail!.total_actions).toBe(2);
      expect(result.audit_trail!.total_duration_ms).toBe(57);
      expect(result.audit_trail!.events).toHaveLength(2);

      expect(result.audit_trail!.events[0].tool).toBe('api_request');
      expect(result.audit_trail!.events[0].duration_ms).toBe(45);
      expect(result.audit_trail!.events[0].mcp_server).toBe('programmatic-feedback');

      expect(result.audit_trail!.events[1].tool).toBe('submit_finding');
      expect(result.audit_trail!.events[1].duration_ms).toBe(12);
      expect(result.audit_trail!.events[1].mcp_server).toBe('feedback-reporter');
    });

    it('should return error for non-existent session', () => {
      const config: FeedbackExplorerConfig = { projectDir, userFeedbackDb, ctoReportsDb, sessionEventsDb };
      const server = createFeedbackExplorerServer(config);

      const result = callTool<GetSessionDetailsResult | ErrorResult>(server, 'get_session_details', {
        session_id: 'nonexistent-session-id',
      });

      expect(isErrorResult(result)).toBe(true);
      if (isErrorResult(result)) {
        expect(result.error).toContain('not found');
      }
    });
  });

  // ==========================================================================
  // list_persona_reports Tests
  // ==========================================================================

  describe('list_persona_reports', () => {
    it('should return CTO reports matching persona name pattern', () => {
      const config: FeedbackExplorerConfig = { projectDir, userFeedbackDb, ctoReportsDb, sessionEventsDb };
      const server = createFeedbackExplorerServer(config);

      createReport(ctoReportsDb, {
        reporting_agent: 'feedback-power-user',
        title: 'Finding: Login broken',
        summary: 'Login button does not work',
        priority: 'high',
        triage_status: 'pending',
      });

      createReport(ctoReportsDb, {
        reporting_agent: 'feedback-power-user',
        title: 'Summary: Session completed',
        summary: 'Completed testing',
        priority: 'normal',
        triage_status: 'triaged',
        triage_outcome: 'acknowledged',
      });

      createReport(ctoReportsDb, {
        reporting_agent: 'feedback-other-user',
        title: 'Different persona',
        summary: 'Should not appear',
      });

      const result = callTool<ListPersonaReportsResult>(server, 'list_persona_reports', {
        persona_name: 'power-user',
        limit: 20,
      });

      expect(result.persona_name).toBe('power-user');
      expect(result.reports).toHaveLength(2);
      expect(result.total).toBe(2);

      expect(result.reports[0].title).toContain('Finding');
      expect(result.reports[0].priority).toBe('high');
      expect(result.reports[0].triage_status).toBe('pending');

      expect(result.reports[1].triage_outcome).toBe('acknowledged');
    });
  });

  // ==========================================================================
  // get_report_details Tests
  // ==========================================================================

  describe('get_report_details', () => {
    it('should return full report details', () => {
      const config: FeedbackExplorerConfig = { projectDir, userFeedbackDb, ctoReportsDb, sessionEventsDb };
      const server = createFeedbackExplorerServer(config);

      const reportId = createReport(ctoReportsDb, {
        reporting_agent: 'feedback-test-user',
        title: 'Critical bug found',
        summary: 'The checkout flow is completely broken',
        category: 'user-feedback',
        priority: 'critical',
        triage_status: 'triaged',
        triage_outcome: 'fix_scheduled',
      });

      const result = callTool<ReportDetails>(server, 'get_report_details', { report_id: reportId });

      expect(result.id).toBe(reportId);
      expect(result.reporting_agent).toBe('feedback-test-user');
      expect(result.title).toBe('Critical bug found');
      expect(result.summary).toBe('The checkout flow is completely broken');
      expect(result.category).toBe('user-feedback');
      expect(result.priority).toBe('critical');
      expect(result.triage_status).toBe('triaged');
      expect(result.triage_outcome).toBe('fix_scheduled');
    });

    it('should return error for non-existent report', () => {
      const config: FeedbackExplorerConfig = { projectDir, userFeedbackDb, ctoReportsDb, sessionEventsDb };
      const server = createFeedbackExplorerServer(config);

      const result = callTool<ReportDetails | ErrorResult>(server, 'get_report_details', {
        report_id: 'nonexistent-report-id',
      });

      expect(isErrorResult(result)).toBe(true);
      if (isErrorResult(result)) {
        expect(result.error).toContain('not found');
      }
    });
  });

  // ==========================================================================
  // get_feedback_overview Tests
  // ==========================================================================

  describe('get_feedback_overview', () => {
    it('should return system overview with satisfaction distribution and recent sessions', () => {
      const config: FeedbackExplorerConfig = { projectDir, userFeedbackDb, ctoReportsDb, sessionEventsDb };
      const server = createFeedbackExplorerServer(config);

      const persona1Id = createPersona(userFeedbackDb, { name: 'user1', description: 'User 1', consumption_mode: 'gui' });
      const persona2Id = createPersona(userFeedbackDb, { name: 'user2', description: 'User 2', consumption_mode: 'api' });

      const runId = createRun(userFeedbackDb, {});

      const now = Date.now();
      const oneHourAgo = new Date(now - 3600000).toISOString();
      const twoHoursAgo = new Date(now - 7200000).toISOString();

      createSession(userFeedbackDb, {
        run_id: runId,
        persona_id: persona1Id,
        started_at: oneHourAgo,
        completed_at: new Date(now).toISOString(),
        findings_count: 5,
        satisfaction_level: 'very_satisfied',
      });

      createSession(userFeedbackDb, {
        run_id: runId,
        persona_id: persona1Id,
        started_at: twoHoursAgo,
        completed_at: oneHourAgo,
        findings_count: 3,
        satisfaction_level: 'satisfied',
      });

      createSession(userFeedbackDb, {
        run_id: runId,
        persona_id: persona2Id,
        started_at: oneHourAgo,
        completed_at: new Date(now).toISOString(),
        findings_count: 2,
        satisfaction_level: 'neutral',
      });

      // Old session (should be included in total but not recent)
      const tenDaysAgo = new Date(now - 10 * 24 * 3600000).toISOString();
      createSession(userFeedbackDb, {
        run_id: runId,
        persona_id: persona2Id,
        started_at: tenDaysAgo,
        findings_count: 1,
        satisfaction_level: 'dissatisfied',
      });

      const result = callTool<GetFeedbackOverviewResult>(server, 'get_feedback_overview', { hours: 168 }); // 7 days

      expect(result.time_window_hours).toBe(168);
      expect(result.persona_count).toBe(2);
      expect(result.total_sessions).toBe(4);
      expect(result.recent_sessions).toBe(3); // Only sessions within 7 days
      expect(result.total_findings).toBe(11);

      expect(result.satisfaction_distribution.very_satisfied).toBe(1);
      expect(result.satisfaction_distribution.satisfied).toBe(1);
      expect(result.satisfaction_distribution.neutral).toBe(1);
      expect(result.satisfaction_distribution.dissatisfied).toBe(1);
      expect(result.satisfaction_distribution.very_dissatisfied).toBe(0);

      expect(result.recent_session_list).toHaveLength(3);
      expect(result.recent_session_list[0].persona_name).toBeDefined();
      expect(result.recent_session_list[0].findings_count).toBeGreaterThanOrEqual(0);
    });
  });

  // ==========================================================================
  // Fail-Loud Tests
  // ==========================================================================

  describe('fail-loud behavior', () => {
    it('should return error when per-session DB is missing', () => {
      const config: FeedbackExplorerConfig = { projectDir, userFeedbackDb, ctoReportsDb, sessionEventsDb };
      const server = createFeedbackExplorerServer(config);

      const personaId = createPersona(userFeedbackDb, { name: 'test-user', description: 'Test', consumption_mode: 'gui' });
      const runId = createRun(userFeedbackDb, {});
      const sessionId = createSession(userFeedbackDb, { run_id: runId, persona_id: personaId });

      // Session exists in main DB but no per-session DB file on disk
      const result = callTool<GetSessionDetailsResult | ErrorResult>(server, 'get_session_details', {
        session_id: sessionId,
      });

      expect(isErrorResult(result)).toBe(true);
      if (isErrorResult(result)) {
        expect(result.error).toContain('Session database not found');
      }
    });

    it('should return error when session-events.db is missing and audit is requested', () => {
      // Create server WITHOUT sessionEventsDb override — it will look for file on disk
      const config: FeedbackExplorerConfig = { projectDir, userFeedbackDb, ctoReportsDb };
      const server = createFeedbackExplorerServer(config);

      const personaId = createPersona(userFeedbackDb, { name: 'test-user', description: 'Test', consumption_mode: 'gui' });
      const runId = createRun(userFeedbackDb, {});
      const sessionId = createSession(userFeedbackDb, { run_id: runId, persona_id: personaId });

      // Create per-session DB so openSessionDb doesn't throw
      const sessionDbPath = path.join(tempDir, '.claude', 'feedback-sessions', `${sessionId}.db`);
      const sessionDb = new Database(sessionDbPath);
      sessionDb.exec(SESSION_DB_SCHEMA);
      sessionDb.close();

      const result = callTool<GetSessionDetailsResult | ErrorResult>(server, 'get_session_details', {
        session_id: sessionId,
        include_audit: true,
      });

      expect(isErrorResult(result)).toBe(true);
      if (isErrorResult(result)) {
        expect(result.error).toContain('session-events.db not found');
      }
    });
  });
});
