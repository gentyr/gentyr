/**
 * Integration Tests for GENTYR AI User Feedback System
 *
 * Tests the full feedback pipeline using real MCP server factories.
 * Uses McpTestClient to invoke real server handlers via processRequest.
 *
 * Test coverage:
 * 1. Persona CRUD + Feature Registration Flow
 * 2. Feedback Run Lifecycle
 * 3. Feedback Reporter → Agent Reports Bridge
 * 4. Change Analysis Edge Cases
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  createTestDb,
  isErrorResult,
} from '../../packages/mcp-servers/src/__testUtils__/index.js';
import {
  USER_FEEDBACK_SCHEMA,
  AGENT_REPORTS_SCHEMA,
} from '../../packages/mcp-servers/src/__testUtils__/schemas.js';

import { McpTestClient } from './helpers/mcp-test-client.js';
import { createUserFeedbackServer } from '../../packages/mcp-servers/src/user-feedback/server.js';
import { createFeedbackReporterServer } from '../../packages/mcp-servers/src/feedback-reporter/server.js';

// ============================================================================
// Integration Tests
// ============================================================================

describe('GENTYR AI User Feedback System - Integration Tests', () => {
  let feedbackDb: Database.Database;
  let reportsDb: Database.Database;
  let tmpDir: string;
  let ufClient: McpTestClient;

  beforeEach(() => {
    feedbackDb = createTestDb(USER_FEEDBACK_SCHEMA);
    reportsDb = createTestDb(AGENT_REPORTS_SCHEMA);
    tmpDir = mkdtempSync(join(tmpdir(), 'feedback-test-'));

    // Create user-feedback MCP client
    const ufServer = createUserFeedbackServer({
      projectDir: tmpDir,
      db: feedbackDb,
    });
    ufClient = new McpTestClient(ufServer);
  });

  afterEach(() => {
    feedbackDb.close();
    reportsDb.close();
  });

  // ==========================================================================
  // 1. Persona CRUD + Feature Registration Flow
  // ==========================================================================

  describe('Persona CRUD + Feature Registration Flow', () => {
    it('should create personas, register features, map them, and verify change analysis', async () => {
      // Create personas for different consumption modes
      const guiPersona = await ufClient.callTool<{ id: string; name: string }>('create_persona', {
        name: 'power-user',
        description: 'An experienced GUI user who uses keyboard shortcuts',
        consumption_mode: 'gui',
        behavior_traits: ['impatient', 'keyboard-focused'],
      });
      expect(guiPersona.id).toBeDefined();

      const cliPersona = await ufClient.callTool<{ id: string; name: string }>('create_persona', {
        name: 'cli-expert',
        description: 'A developer who prefers the CLI',
        consumption_mode: 'cli',
      });
      expect(cliPersona.id).toBeDefined();

      const apiPersona = await ufClient.callTool<{ id: string; name: string }>('create_persona', {
        name: 'api-consumer',
        description: 'A developer using the REST API',
        consumption_mode: 'api',
        endpoints: ['/api/tasks', '/api/auth'],
      });
      expect(apiPersona.id).toBeDefined();

      const sdkPersona = await ufClient.callTool<{ id: string; name: string }>('create_persona', {
        name: 'sdk-developer',
        description: 'A developer using the SDK package',
        consumption_mode: 'sdk',
        endpoints: ['@acme/sdk', 'https://docs.acme.com'],
      });
      expect(sdkPersona.id).toBeDefined();

      const adkPersona = await ufClient.callTool<{ id: string; name: string }>('create_persona', {
        name: 'adk-agent',
        description: 'An AI agent consuming the SDK programmatically',
        consumption_mode: 'adk',
        endpoints: ['@acme/sdk', '/path/to/docs'],
      });
      expect(adkPersona.id).toBeDefined();

      // Register features with file patterns
      const authFeature = await ufClient.callTool<{ id: string; name: string }>('register_feature', {
        name: 'authentication',
        description: 'User login and session management',
        file_patterns: ['src/auth/**', 'src/middleware/auth*'],
        category: 'auth',
      });
      expect(authFeature.id).toBeDefined();

      const tasksFeature = await ufClient.callTool<{ id: string; name: string }>('register_feature', {
        name: 'task-management',
        description: 'CRUD operations for tasks',
        file_patterns: ['src/tasks/**', 'src/api/tasks.ts'],
        category: 'core',
      });
      expect(tasksFeature.id).toBeDefined();

      // Map personas to features
      await ufClient.callTool('map_persona_feature', {
        persona_id: guiPersona.id,
        feature_id: authFeature.id,
        priority: 'high',
        test_scenarios: ['Login form', 'Logout', 'Session timeout'],
      });

      await ufClient.callTool('map_persona_feature', {
        persona_id: guiPersona.id,
        feature_id: tasksFeature.id,
        priority: 'critical',
        test_scenarios: ['Create task', 'Complete task', 'Delete task'],
      });

      await ufClient.callTool('map_persona_feature', {
        persona_id: cliPersona.id,
        feature_id: tasksFeature.id,
        priority: 'high',
      });

      await ufClient.callTool('map_persona_feature', {
        persona_id: apiPersona.id,
        feature_id: authFeature.id,
        priority: 'critical',
      });

      await ufClient.callTool('map_persona_feature', {
        persona_id: apiPersona.id,
        feature_id: tasksFeature.id,
        priority: 'high',
      });

      await ufClient.callTool('map_persona_feature', {
        persona_id: sdkPersona.id,
        feature_id: tasksFeature.id,
        priority: 'normal',
      });

      await ufClient.callTool('map_persona_feature', {
        persona_id: adkPersona.id,
        feature_id: tasksFeature.id,
        priority: 'normal',
      });

      // Verify get_personas_for_changes returns correct personas
      const changedFiles = ['src/auth/login.ts', 'src/tasks/create.ts'];
      const analysis = await ufClient.callTool<{
        personas: Array<{
          persona: { id: string; name: string };
          matched_features: Array<{ feature_id: string; feature_name: string; priority: string }>;
        }>;
        matched_features: Array<{ id: string; name: string }>;
      }>('get_personas_for_changes', { changed_files: changedFiles });

      expect(analysis.personas).toHaveLength(5);
      expect(analysis.matched_features).toHaveLength(2);

      const personaNames = analysis.personas.map(p => p.persona.name).sort();
      expect(personaNames).toEqual(['adk-agent', 'api-consumer', 'cli-expert', 'power-user', 'sdk-developer']);

      // Verify gui persona has both features
      const guiAnalysis = analysis.personas.find(p => p.persona.name === 'power-user');
      expect(guiAnalysis?.matched_features).toHaveLength(2);

      // Verify sdk and adk personas have tasks feature only
      const sdkAnalysis = analysis.personas.find(p => p.persona.name === 'sdk-developer');
      expect(sdkAnalysis?.matched_features).toHaveLength(1);
      const adkAnalysis = analysis.personas.find(p => p.persona.name === 'adk-agent');
      expect(adkAnalysis?.matched_features).toHaveLength(1);
    });
  });

  // ==========================================================================
  // 2. Feedback Run Lifecycle
  // ==========================================================================

  describe('Feedback Run Lifecycle', () => {
    it('should create a run, track sessions, complete them, and verify status transitions', async () => {
      // Setup: Create personas and features
      const guiPersona = await ufClient.callTool<{ id: string; name: string }>('create_persona', {
        name: 'gui-tester',
        description: 'GUI tester',
        consumption_mode: 'gui',
      });

      const cliPersona = await ufClient.callTool<{ id: string; name: string }>('create_persona', {
        name: 'cli-tester',
        description: 'CLI tester',
        consumption_mode: 'cli',
      });

      const feature = await ufClient.callTool<{ id: string; name: string }>('register_feature', {
        name: 'core-feature',
        file_patterns: ['src/core/**'],
      });

      await ufClient.callTool('map_persona_feature', { persona_id: guiPersona.id, feature_id: feature.id });
      await ufClient.callTool('map_persona_feature', { persona_id: cliPersona.id, feature_id: feature.id });

      // Start feedback run
      const run = await ufClient.callTool<{
        id: string;
        personas_triggered: string[];
        sessions: Array<{ id: string; persona_id: string; status: string }>;
      }>('start_feedback_run', {
        trigger_type: 'manual',
        trigger_ref: 'test-trigger',
        changed_files: ['src/core/utils.ts'],
      });

      expect(run.sessions).toHaveLength(2);
      expect(run.personas_triggered).toHaveLength(2);

      // Verify sessions are created with 'pending' status
      expect(run.sessions.every(s => s.status === 'pending')).toBe(true);

      // Simulate completing the first session with findings
      const sessionDb1 = createTestDb(`
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
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS session_summary (
          id TEXT PRIMARY KEY DEFAULT 'summary',
          overall_impression TEXT NOT NULL,
          areas_tested TEXT NOT NULL DEFAULT '[]',
          areas_not_tested TEXT NOT NULL DEFAULT '[]',
          confidence TEXT NOT NULL,
          summary_notes TEXT,
          created_at TEXT NOT NULL
        );
      `);
      const reporterServer1 = createFeedbackReporterServer({
        personaName: 'gui-tester',
        sessionId: run.sessions[0].id,
        projectDir: tmpDir,
        sessionDb: sessionDb1,
        reportsDb,
        auditDbPath: ':memory:',
      });
      const reporterClient1 = new McpTestClient(reporterServer1);

      const finding1_1 = await reporterClient1.callTool<{ id: string; report_id: string }>('submit_finding', {
        title: 'Login button not responsive',
        category: 'usability',
        severity: 'high',
        description: 'The login button does not respond to clicks on mobile',
      });

      const finding1_2 = await reporterClient1.callTool<{ id: string; report_id: string }>('submit_finding', {
        title: 'Missing error message',
        category: 'functionality',
        severity: 'medium',
        description: 'No error shown on wrong password',
      });

      const reportIds1 = [finding1_1.report_id, finding1_2.report_id];

      await ufClient.callTool('complete_feedback_session', {
        session_id: run.sessions[0].id,
        status: 'completed',
        findings_count: 2,
        report_ids: reportIds1,
      });

      // Simulate completing the second session
      const sessionDb2 = createTestDb(`
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
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS session_summary (
          id TEXT PRIMARY KEY DEFAULT 'summary',
          overall_impression TEXT NOT NULL,
          areas_tested TEXT NOT NULL DEFAULT '[]',
          areas_not_tested TEXT NOT NULL DEFAULT '[]',
          confidence TEXT NOT NULL,
          summary_notes TEXT,
          created_at TEXT NOT NULL
        );
      `);
      const reporterServer2 = createFeedbackReporterServer({
        personaName: 'cli-tester',
        sessionId: run.sessions[1].id,
        projectDir: tmpDir,
        sessionDb: sessionDb2,
        reportsDb,
        auditDbPath: ':memory:',
      });
      const reporterClient2 = new McpTestClient(reporterServer2);

      const finding2_1 = await reporterClient2.callTool<{ id: string; report_id: string }>('submit_finding', {
        title: 'CLI missing --help flag',
        category: 'usability',
        severity: 'low',
        description: 'The CLI does not support --help flag',
      });

      const reportIds2 = [finding2_1.report_id];

      await ufClient.callTool('complete_feedback_session', {
        session_id: run.sessions[1].id,
        status: 'completed',
        findings_count: 1,
        report_ids: reportIds2,
      });

      // Update run status to completed
      feedbackDb
        .prepare('UPDATE feedback_runs SET status = ?, completed_at = ? WHERE id = ?')
        .run('completed', new Date().toISOString(), run.id);

      // Verify get_feedback_run_summary aggregates correctly
      const summary = await ufClient.callTool<{
        run_id: string;
        trigger_type: string;
        status: string;
        started_at: string;
        completed_at: string | null;
        total_sessions: number;
        completed_sessions: number;
        failed_sessions: number;
        total_findings: number;
        sessions: Array<{
          session_id: string;
          persona_id: string;
          status: string;
          findings_count: number;
          report_ids: string[];
        }>;
      }>('get_feedback_run_summary', { id: run.id });

      expect(summary.status).toBe('completed');
      expect(summary.total_sessions).toBe(2);
      expect(summary.completed_sessions).toBe(2);
      expect(summary.failed_sessions).toBe(0);
      expect(summary.total_findings).toBe(3);

      // Clean up
      sessionDb1.close();
      sessionDb2.close();
    });

    it('should handle partial completion (some sessions fail)', async () => {
      const persona1 = await ufClient.callTool<{ id: string; name: string }>('create_persona', {
        name: 'p1',
        description: 'P1',
        consumption_mode: 'gui',
      });
      const persona2 = await ufClient.callTool<{ id: string; name: string }>('create_persona', {
        name: 'p2',
        description: 'P2',
        consumption_mode: 'cli',
      });
      const feature = await ufClient.callTool<{ id: string; name: string }>('register_feature', {
        name: 'f1',
        file_patterns: ['src/**'],
      });

      await ufClient.callTool('map_persona_feature', { persona_id: persona1.id, feature_id: feature.id });
      await ufClient.callTool('map_persona_feature', { persona_id: persona2.id, feature_id: feature.id });

      const run = await ufClient.callTool<{
        id: string;
        personas_triggered: string[];
        sessions: Array<{ id: string }>;
      }>('start_feedback_run', {
        trigger_type: 'manual',
        changed_files: ['src/index.ts'],
      });

      // Complete first session successfully
      await ufClient.callTool('complete_feedback_session', {
        session_id: run.sessions[0].id,
        status: 'completed',
        findings_count: 1,
      });

      // Second session fails
      await ufClient.callTool('complete_feedback_session', {
        session_id: run.sessions[1].id,
        status: 'failed',
      });

      // Update run status to partial
      feedbackDb
        .prepare('UPDATE feedback_runs SET status = ?, completed_at = ? WHERE id = ?')
        .run('partial', new Date().toISOString(), run.id);

      const summary = await ufClient.callTool<{
        run_id: string;
        status: string;
        completed_sessions: number;
        failed_sessions: number;
      }>('get_feedback_run_summary', { id: run.id });

      expect(summary.status).toBe('partial');
      expect(summary.completed_sessions).toBe(1);
      expect(summary.failed_sessions).toBe(1);
    });
  });

  // ==========================================================================
  // 3. Feedback Reporter → Agent Reports Bridge
  // ==========================================================================

  describe('Feedback Reporter → Agent Reports Bridge', () => {
    it('should submit findings and verify reports appear in agent-reports DB', async () => {
      const sessionDb = createTestDb(`
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
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS session_summary (
          id TEXT PRIMARY KEY DEFAULT 'summary',
          overall_impression TEXT NOT NULL,
          areas_tested TEXT NOT NULL DEFAULT '[]',
          areas_not_tested TEXT NOT NULL DEFAULT '[]',
          confidence TEXT NOT NULL,
          summary_notes TEXT,
          created_at TEXT NOT NULL
        );
      `);

      const reporterServer = createFeedbackReporterServer({
        personaName: 'test-persona',
        sessionId: 'test-session-123',
        projectDir: tmpDir,
        sessionDb,
        reportsDb,
        auditDbPath: ':memory:',
      });
      const reporterClient = new McpTestClient(reporterServer);

      const finding1 = await reporterClient.callTool<{ id: string; report_id: string }>('submit_finding', {
        title: 'Critical security issue',
        category: 'security',
        severity: 'critical',
        description: 'Credentials exposed in API response',
      });

      const finding2 = await reporterClient.callTool<{ id: string; report_id: string }>('submit_finding', {
        title: 'Typo in error message',
        category: 'content',
        severity: 'low',
        description: 'Error message has a typo',
      });

      expect(finding1.id).toBeDefined();
      expect(finding1.report_id).toBeDefined();
      expect(finding2.id).toBeDefined();
      expect(finding2.report_id).toBeDefined();

      // Verify reports in agent-reports DB
      interface ReportRow {
        id: string;
        reporting_agent: string;
        title: string;
        category: string;
        priority: string;
        triage_status: string;
      }

      const reports = reportsDb.prepare('SELECT * FROM reports').all() as ReportRow[];
      expect(reports).toHaveLength(2);

      // Verify category is 'user-feedback'
      expect(reports.every(r => r.category === 'user-feedback')).toBe(true);

      // Verify reporting_agent includes persona name
      expect(reports.every(r => r.reporting_agent === 'feedback-test-persona')).toBe(true);

      // Verify severity-to-priority mapping
      const criticalReport = reports.find(r => r.title === 'Critical security issue');
      expect(criticalReport?.priority).toBe('critical');

      const lowReport = reports.find(r => r.title === 'Typo in error message');
      expect(lowReport?.priority).toBe('low');

      // Verify triage_status is 'pending'
      expect(reports.every(r => r.triage_status === 'pending')).toBe(true);

      sessionDb.close();
    });

    it('should submit session summary and verify report in agent-reports', async () => {
      const sessionDb = createTestDb(`
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
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS session_summary (
          id TEXT PRIMARY KEY DEFAULT 'summary',
          overall_impression TEXT NOT NULL,
          areas_tested TEXT NOT NULL DEFAULT '[]',
          areas_not_tested TEXT NOT NULL DEFAULT '[]',
          confidence TEXT NOT NULL,
          summary_notes TEXT,
          created_at TEXT NOT NULL
        );
      `);

      const reporterServer = createFeedbackReporterServer({
        personaName: 'gui-user',
        sessionId: 'summary-session-456',
        projectDir: tmpDir,
        sessionDb,
        reportsDb,
        auditDbPath: ':memory:',
      });
      const reporterClient = new McpTestClient(reporterServer);

      const summary = await reporterClient.callTool<{ report_id: string }>('submit_summary', {
        overall_impression: 'negative',
        areas_tested: ['Login flow', 'Task creation', 'Settings page'],
        areas_not_tested: ['Password reset'],
        confidence: 'high',
        summary_notes: 'Multiple critical issues found',
      });

      expect(summary.report_id).toBeDefined();

      interface ReportRow {
        id: string;
        reporting_agent: string;
        title: string;
        summary: string;
        priority: string;
      }

      const report = reportsDb.prepare('SELECT * FROM reports WHERE id = ?').get(summary.report_id) as ReportRow;
      expect(report.reporting_agent).toBe('feedback-gui-user');
      expect(report.title).toBe('Feedback Summary: gui-user - negative');
      expect(report.summary).toContain('Overall Impression: negative');
      expect(report.summary).toContain('Login flow');
      expect(report.priority).toBe('high'); // negative → high

      sessionDb.close();
    });
  });

  // ==========================================================================
  // 4. Change Analysis Edge Cases
  // ==========================================================================

  describe('Change Analysis Edge Cases', () => {
    it('should return empty personas when no features match', async () => {
      const persona = await ufClient.callTool<{ id: string; name: string }>('create_persona', {
        name: 'p1',
        description: 'P1',
        consumption_mode: 'gui',
      });
      const feature = await ufClient.callTool<{ id: string; name: string }>('register_feature', {
        name: 'auth',
        file_patterns: ['src/auth/**'],
      });
      await ufClient.callTool('map_persona_feature', { persona_id: persona.id, feature_id: feature.id });

      const analysis = await ufClient.callTool<{
        personas: Array<{ persona: { id: string; name: string } }>;
        matched_features: Array<{ id: string; name: string }>;
      }>('get_personas_for_changes', { changed_files: ['src/billing/invoice.ts'] });

      expect(analysis.personas).toHaveLength(0);
      expect(analysis.matched_features).toHaveLength(0);
    });

    it('should match multiple features from one file change', async () => {
      const persona = await ufClient.callTool<{ id: string; name: string }>('create_persona', {
        name: 'p1',
        description: 'P1',
        consumption_mode: 'gui',
      });
      const feature1 = await ufClient.callTool<{ id: string; name: string }>('register_feature', {
        name: 'auth',
        file_patterns: ['src/auth/**'],
      });
      const feature2 = await ufClient.callTool<{ id: string; name: string }>('register_feature', {
        name: 'middleware',
        file_patterns: ['src/auth/middleware*'],
      });

      await ufClient.callTool('map_persona_feature', { persona_id: persona.id, feature_id: feature1.id });
      await ufClient.callTool('map_persona_feature', { persona_id: persona.id, feature_id: feature2.id });

      const analysis = await ufClient.callTool<{
        personas: Array<{
          persona: { id: string; name: string };
          matched_features: Array<{ feature_id: string; feature_name: string }>;
        }>;
        matched_features: Array<{ id: string; name: string }>;
      }>('get_personas_for_changes', { changed_files: ['src/auth/middleware.ts'] });

      expect(analysis.personas).toHaveLength(1);
      expect(analysis.personas[0].matched_features).toHaveLength(2);
      expect(analysis.matched_features).toHaveLength(2);
    });

    it('should exclude disabled personas', async () => {
      const persona = await ufClient.callTool<{ id: string; name: string }>('create_persona', {
        name: 'disabled',
        description: 'Off',
        consumption_mode: 'gui',
      });
      const feature = await ufClient.callTool<{ id: string; name: string }>('register_feature', {
        name: 'f1',
        file_patterns: ['src/**'],
      });
      await ufClient.callTool('map_persona_feature', { persona_id: persona.id, feature_id: feature.id });

      // Disable the persona
      feedbackDb.prepare('UPDATE personas SET enabled = 0 WHERE id = ?').run(persona.id);

      const analysis = await ufClient.callTool<{
        personas: Array<{ persona: { id: string; name: string } }>;
        matched_features: Array<{ id: string; name: string }>;
      }>('get_personas_for_changes', { changed_files: ['src/index.ts'] });

      expect(analysis.personas).toHaveLength(0);
    });

    it('should handle feature with no mapped personas', async () => {
      await ufClient.callTool<{ id: string; name: string }>('register_feature', {
        name: 'orphan-feature',
        file_patterns: ['src/orphan/**'],
      });

      const analysis = await ufClient.callTool<{
        personas: Array<{ persona: { id: string; name: string } }>;
        matched_features: Array<{ id: string; name: string }>;
      }>('get_personas_for_changes', { changed_files: ['src/orphan/file.ts'] });

      expect(analysis.personas).toHaveLength(0);
      expect(analysis.matched_features).toHaveLength(1);
    });
  });
});
