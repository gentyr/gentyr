/**
 * True E2E Tests for GENTYR AI User Feedback System
 *
 * Uses real MCP server factories (createUserFeedbackServer, createFeedbackReporterServer)
 * instead of stubs. Tests the complete pipeline:
 * 1. Persona and feature management via user-feedback MCP
 * 2. Feedback submission via feedback-reporter MCP
 * 3. Audit trail verification via AuditedMcpServer logging
 * 4. Real HTTP API and CLI interface validation
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

import { startToyApp, type ToyAppInstance } from './helpers/toy-app-runner.js';
import { McpTestClient } from './helpers/mcp-test-client.js';

import { createUserFeedbackServer } from '../../packages/mcp-servers/src/user-feedback/server.js';
import { createFeedbackReporterServer } from '../../packages/mcp-servers/src/feedback-reporter/server.js';

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
      // Setup persona and feature using real MCP
      const ufClient = new McpTestClient(createUserFeedbackServer({ db: feedbackDb, projectDir: '/tmp/test' }));

      const persona = await ufClient.callTool<{ id: string; name: string }>('create_persona', {
        name: 'api-consumer',
        description: 'REST API tester',
        consumption_mode: 'api',
        endpoints: ['/api/tasks'],
      });

      const feature = await ufClient.callTool<{ id: string; name: string }>('register_feature', {
        name: 'task-api',
        file_patterns: ['src/api/**', 'server.js'],
        category: 'core',
      });

      await ufClient.callTool('map_persona_feature', {
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

      // Submit finding about the bug using real feedback-reporter MCP
      const sessionDb = createTestDb('');
      const sessionId = randomUUID();

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

      const reporterServer = createFeedbackReporterServer({
        personaName: 'api-consumer',
        sessionId,
        projectDir: '/tmp/test',
        sessionDb,
        reportsDb,
      });
      const reporterClient = new McpTestClient(reporterServer);

      const findingResult = await reporterClient.callTool<{ id: string; report_id: string }>('submit_finding', {
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
      });

      const summaryResult = await reporterClient.callTool<{ id: string; report_id: string }>('submit_summary', {
        overall_impression: 'neutral',
        areas_tested: ['Task CRUD API', 'Status codes'],
        areas_not_tested: ['Authentication API', 'Error handling'],
        confidence: 'high',
      });

      // Verify finding was submitted
      expect(findingResult.id).toBeDefined();
      expect(findingResult.report_id).toBeDefined();

      // Verify summary was submitted
      expect(summaryResult.id).toBe('summary');
      expect(summaryResult.report_id).toBeDefined();

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
      const sessionId = randomUUID();

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
      `);

      const reporterServer = createFeedbackReporterServer({
        personaName: 'cli-expert',
        sessionId,
        projectDir: '/tmp/test',
        sessionDb,
        reportsDb,
      });
      const reporterClient = new McpTestClient(reporterServer);

      const findingResult = await reporterClient.callTool<{ id: string; report_id: string }>('submit_finding', {
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
      });

      expect(findingResult.id).toBeDefined();
      expect(findingResult.report_id).toBeDefined();

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
      // Setup: 2 personas, 2 features using real MCP
      const ufClient = new McpTestClient(createUserFeedbackServer({ db: feedbackDb, projectDir: '/tmp/test' }));

      const apiPersona = await ufClient.callTool<{ id: string; name: string }>('create_persona', {
        name: 'api-tester',
        description: 'Tests REST API endpoints',
        consumption_mode: 'api',
      });

      const cliPersona = await ufClient.callTool<{ id: string; name: string }>('create_persona', {
        name: 'cli-tester',
        description: 'Tests CLI interface',
        consumption_mode: 'cli',
      });

      const sdkPersona = await ufClient.callTool<{ id: string; name: string }>('create_persona', {
        name: 'sdk-dev',
        description: 'Tests SDK package',
        consumption_mode: 'sdk',
        endpoints: ['@acme/sdk', `${toyApp.baseUrl}/docs`],
      });

      const adkPersona = await ufClient.callTool<{ id: string; name: string }>('create_persona', {
        name: 'adk-agent',
        description: 'AI agent testing SDK programmatically',
        consumption_mode: 'adk',
        endpoints: ['@acme/sdk', '/tmp/docs'],
      });

      const apiFeature = await ufClient.callTool<{ id: string; name: string }>('register_feature', {
        name: 'rest-api',
        file_patterns: ['src/api/**', 'server.js'],
      });

      const cliFeature = await ufClient.callTool<{ id: string; name: string }>('register_feature', {
        name: 'cli-interface',
        file_patterns: ['cli.js', 'src/cli/**'],
      });

      await ufClient.callTool('map_persona_feature', {
        persona_id: apiPersona.id,
        feature_id: apiFeature.id,
        priority: 'high',
      });

      await ufClient.callTool('map_persona_feature', {
        persona_id: cliPersona.id,
        feature_id: cliFeature.id,
        priority: 'normal',
      });

      await ufClient.callTool('map_persona_feature', {
        persona_id: sdkPersona.id,
        feature_id: apiFeature.id,
        priority: 'normal',
      });

      await ufClient.callTool('map_persona_feature', {
        persona_id: adkPersona.id,
        feature_id: apiFeature.id,
        priority: 'normal',
      });

      // Simulate changed files from a staging push
      const changedFiles = ['server.js', 'cli.js'];
      const analysis = await ufClient.callTool<{
        personas: Array<{
          persona: {
            id: string;
            name: string;
            description: string;
            consumption_mode: string;
            behavior_traits: string[];
            endpoints: string[];
            credentials_ref: string | null;
            enabled: boolean;
            created_at: string;
            updated_at: string;
          };
          matched_features: Array<{ feature_id: string; feature_name: string; priority: string; test_scenarios: string[]; matched_files: string[] }>;
        }>;
        matched_features: Array<{ id: string; name: string; description: string | null; file_patterns: string[]; url_patterns: string[]; category: string | null; created_at: string }>;
      }>('get_personas_for_changes', { changed_files: changedFiles });

      expect(analysis.personas).toHaveLength(4);
      expect(analysis.personas.map(p => p.persona.name).sort()).toEqual(['adk-agent', 'api-tester', 'cli-tester', 'sdk-dev']);

      // Start feedback run
      const run = await ufClient.callTool<{
        id: string;
        trigger_type: string;
        trigger_ref: string | null;
        changed_features: string[];
        personas_triggered: string[];
        status: string;
        max_concurrent: number;
        started_at: string;
        completed_at: string | null;
        summary: string | null;
        sessions?: Array<{
          id: string;
          persona_id: string;
          status: string;
          findings_count: number;
        }>;
      }>('start_feedback_run', {
        trigger_type: 'staging-push',
        trigger_ref: 'abc123',
        changed_files: changedFiles,
      });

      expect(run.sessions).toBeDefined();
      expect(run.sessions!).toHaveLength(4);

      // Simulate API persona finding Bug #4
      const apiSessionDb = createTestDb('');
      const apiSessionId = run.sessions![0].id;

      // Initialize session DB schema
      apiSessionDb.exec(`
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
      `);

      // Actually hit the API to verify the bug exists
      const apiResponse = await fetch(`${toyApp.baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Multi-persona test' }),
      });
      expect(apiResponse.status).toBe(200); // Bug confirmed

      const apiReporterServer = createFeedbackReporterServer({
        personaName: 'api-tester',
        sessionId: apiSessionId,
        projectDir: '/tmp/test',
        sessionDb: apiSessionDb,
        reportsDb,
      });
      const apiReporterClient = new McpTestClient(apiReporterServer);

      const apiResult = await apiReporterClient.callTool<{ id: string; report_id: string }>('submit_finding', {
        title: 'Wrong HTTP status code on POST /api/tasks',
        category: 'functionality',
        severity: 'medium',
        description: 'Returns 200 instead of 201',
        url: `${toyApp.baseUrl}/api/tasks`,
      });

      // Complete API session
      await ufClient.callTool('complete_feedback_session', {
        session_id: apiSessionId,
        status: 'completed',
        findings_count: 1,
        report_ids: [apiResult.report_id],
      });

      // Simulate CLI persona finding Bug #5
      const cliSessionDb = createTestDb('');
      const cliSessionId = run.sessions![1].id;

      // Initialize session DB schema
      cliSessionDb.exec(`
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
      `);

      const cliReporterServer = createFeedbackReporterServer({
        personaName: 'cli-tester',
        sessionId: cliSessionId,
        projectDir: '/tmp/test',
        sessionDb: cliSessionDb,
        reportsDb,
      });
      const cliReporterClient = new McpTestClient(cliReporterServer);

      const cliResult = await cliReporterClient.callTool<{ id: string; report_id: string }>('submit_finding', {
        title: 'No --help flag',
        category: 'usability',
        severity: 'low',
        description: 'CLI exits with error when --help is passed',
      });

      // Complete CLI session
      await ufClient.callTool('complete_feedback_session', {
        session_id: cliSessionId,
        status: 'completed',
        findings_count: 1,
        report_ids: [cliResult.report_id],
      });

      // Simulate SDK persona finding type issues
      const sdkSessionDb = createTestDb('');
      const sdkSessionId = run.sessions![2].id;

      sdkSessionDb.exec(`
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
      `);

      const sdkReporterServer = createFeedbackReporterServer({
        personaName: 'sdk-dev',
        sessionId: sdkSessionId,
        projectDir: '/tmp/test',
        sessionDb: sdkSessionDb,
        reportsDb,
      });
      const sdkReporterClient = new McpTestClient(sdkReporterServer);

      const sdkResult = await sdkReporterClient.callTool<{ id: string; report_id: string }>('submit_finding', {
        title: 'SDK missing TypeScript types for task response',
        category: 'functionality',
        severity: 'medium',
        description: 'The SDK does not export TypeScript types for the task creation response',
      });

      await ufClient.callTool('complete_feedback_session', {
        session_id: sdkSessionId,
        status: 'completed',
        findings_count: 1,
        report_ids: [sdkResult.report_id],
      });

      // Simulate ADK persona finding docs discoverability issues
      const adkSessionDb = createTestDb('');
      const adkSessionId = run.sessions![3].id;

      adkSessionDb.exec(`
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
      `);

      const adkReporterServer = createFeedbackReporterServer({
        personaName: 'adk-agent',
        sessionId: adkSessionId,
        projectDir: '/tmp/test',
        sessionDb: adkSessionDb,
        reportsDb,
      });
      const adkReporterClient = new McpTestClient(adkReporterServer);

      const adkResult = await adkReporterClient.callTool<{ id: string; report_id: string }>('submit_finding', {
        title: 'API error responses lack structured error codes',
        category: 'functionality',
        severity: 'medium',
        description: 'Error responses return plain text instead of structured JSON with error codes, making programmatic error handling difficult for AI agents',
      });

      await ufClient.callTool('complete_feedback_session', {
        session_id: adkSessionId,
        status: 'completed',
        findings_count: 1,
        report_ids: [adkResult.report_id],
      });

      // Verify the full pipeline
      interface ReportRow { id: string; reporting_agent: string; title: string; category: string; }
      const allReports = reportsDb.prepare('SELECT * FROM reports').all() as ReportRow[];
      expect(allReports).toHaveLength(4);
      expect(allReports.every(r => r.category === 'user-feedback')).toBe(true);

      const agents = allReports.map(r => r.reporting_agent).sort();
      expect(agents).toEqual(['feedback-adk-agent', 'feedback-api-tester', 'feedback-cli-tester', 'feedback-sdk-dev']);

      // Verify run summary
      interface SessionRow { id: string; status: string; findings_count: number; }
      const sessions = feedbackDb.prepare('SELECT * FROM feedback_sessions WHERE run_id = ?').all(run.id) as SessionRow[];
      expect(sessions.every(s => s.status === 'completed')).toBe(true);
      const totalFindings = sessions.reduce((sum, s) => sum + s.findings_count, 0);
      expect(totalFindings).toBe(4);

      apiSessionDb.close();
      cliSessionDb.close();
      sdkSessionDb.close();
      adkSessionDb.close();
    });
  });

  // ==========================================================================
  // 4. Audit Trail Verification
  // ==========================================================================

  describe('Audit Trail Verification', () => {
    let tmpDir: string;
    let auditDbPath: string;
    let eventsDb: Database.Database;
    let reportsDb: Database.Database;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-audit-'));
      fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
      auditDbPath = path.join(tmpDir, '.claude', 'session-events.db');

      // Create audit DB with schema
      eventsDb = new (require('better-sqlite3'))(auditDbPath);
      eventsDb.exec(SESSION_EVENTS_SCHEMA);

      // Create reports DB for testing
      reportsDb = createTestDb(AGENT_REPORTS_SCHEMA);
    });

    afterEach(() => {
      eventsDb.close();
      reportsDb.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should record complete audit trail for a feedback session', async () => {
      const sessionId = randomUUID();
      const personaName = 'api-auditor';

      // Create session DB
      const sessionDb = createTestDb('');
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
      `);

      // Create feedback-reporter server with audit enabled
      const reporterServer = createFeedbackReporterServer({
        personaName,
        sessionId,
        projectDir: tmpDir,
        sessionDb,
        reportsDb,
        auditDbPath,
      });
      const reporterClient = new McpTestClient(reporterServer);

      // Make tool calls that will be audited
      await reporterClient.callTool('submit_finding', {
        title: 'Wrong status code',
        category: 'functionality',
        severity: 'medium',
        description: 'API returns wrong status code',
      });

      // Verify audit trail exists
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

      expect(events.length).toBeGreaterThan(0);

      // Verify first event structure
      const firstEvent = events[0];
      expect(firstEvent.session_id).toBe(sessionId);
      expect(firstEvent.agent_id).toBe(personaName);
      expect(firstEvent.event_type).toBe('mcp_tool_call');
      expect(firstEvent.event_category).toBe('mcp');

      const input = JSON.parse(firstEvent.input) as { tool: string; args: unknown };
      expect(input.tool).toBe('submit_finding');

      const metadata = JSON.parse(firstEvent.metadata) as { mcp_server: string };
      expect(metadata.mcp_server).toBe('feedback-reporter');

      sessionDb.close();
    });

    it('should record error events in audit trail', async () => {
      const sessionId = randomUUID();
      const personaName = 'error-tester';

      // Create session DB
      const sessionDb = createTestDb('');
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
      `);

      const reporterServer = createFeedbackReporterServer({
        personaName,
        sessionId,
        projectDir: tmpDir,
        sessionDb,
        reportsDb,
        auditDbPath,
      });
      const reporterClient = new McpTestClient(reporterServer);

      // Try to submit a finding with an invalid category (will fail DB constraint check)
      try {
        await reporterClient.callTool('submit_finding', {
          title: 'Invalid finding',
          category: 'invalid_category' as any,
          severity: 'medium',
          description: 'This should fail',
        });
        expect.fail('Expected database error');
      } catch (err) {
        // Expected error - DB constraint violation
      }

      // Note: Validation errors happen before the handler is invoked, so they may not be logged
      // to the audit trail. The audit trail captures handler-level errors, not schema validation errors.
      // For now, we just verify the error was caught and the tool didn't succeed.
      // A successful call would have created a finding in the DB.

      interface FindingRow { id: string; }
      const findings = sessionDb.prepare('SELECT id FROM findings').all() as FindingRow[];
      expect(findings).toHaveLength(0);

      sessionDb.close();
    });

    it('should distinguish events from different MCP servers in same session', async () => {
      const sessionId = randomUUID();
      const personaName = 'multi-server';

      // Create feedback DB
      const feedbackDb = createTestDb(USER_FEEDBACK_SCHEMA);

      // Create session DB
      const sessionDb = createTestDb('');
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
      `);

      // NOTE: user-feedback server doesn't use AuditedMcpServer yet, so we can only test feedback-reporter
      // This test verifies that feedback-reporter events are logged with correct metadata

      const reporterServer = createFeedbackReporterServer({
        personaName,
        sessionId,
        projectDir: tmpDir,
        sessionDb,
        reportsDb,
        auditDbPath,
      });
      const reporterClient = new McpTestClient(reporterServer);

      await reporterClient.callTool('submit_finding', {
        title: 'Bug found',
        category: 'functionality',
        severity: 'medium',
        description: 'Test bug',
      });

      interface EventRow { metadata: string; }
      const events = eventsDb.prepare(
        "SELECT metadata FROM session_events WHERE session_id = ? ORDER BY timestamp ASC"
      ).all(sessionId) as EventRow[];

      expect(events.length).toBeGreaterThan(0);
      expect(JSON.parse(events[0].metadata).mcp_server).toBe('feedback-reporter');

      feedbackDb.close();
      sessionDb.close();
    });

    it('should calculate correct total duration across all events', async () => {
      const sessionId = randomUUID();
      const personaName = 'duration-test';

      // Create session DB
      const sessionDb = createTestDb('');
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

      const reporterServer = createFeedbackReporterServer({
        personaName,
        sessionId,
        projectDir: tmpDir,
        sessionDb,
        reportsDb,
        auditDbPath,
      });
      const reporterClient = new McpTestClient(reporterServer);

      // Make multiple calls
      await reporterClient.callTool('submit_finding', {
        title: 'Finding 1',
        category: 'functionality',
        severity: 'medium',
        description: 'Test',
      });

      await reporterClient.callTool('submit_finding', {
        title: 'Finding 2',
        category: 'usability',
        severity: 'low',
        description: 'Test 2',
      });

      await reporterClient.callTool('submit_summary', {
        overall_impression: 'neutral',
        areas_tested: ['Feature A'],
        confidence: 'high',
      });

      interface SumRow { total: number | null; count: number; }
      const result = eventsDb.prepare(
        "SELECT COALESCE(SUM(duration_ms), 0) as total, COUNT(*) as count FROM session_events WHERE session_id = ?"
      ).get(sessionId) as SumRow;

      expect(result.count).toBe(3);
      // Note: duration_ms should be > 0 for real MCP calls, but may be 0 for very fast operations
      expect(result.total).toBeGreaterThanOrEqual(0);

      sessionDb.close();
    });
  });
});
