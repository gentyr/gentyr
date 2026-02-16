/**
 * Real Claude Agent E2E Tests for GENTYR AI User Feedback System
 *
 * These tests spawn actual Claude CLI sessions with real MCP servers
 * against the toy app. They verify the complete feedback pipeline:
 *
 * 1. Launch toy app on a free port
 * 2. Create a test project with personas/features/mappings
 * 3. Use real feedback-launcher functions to configure and spawn agents
 * 4. Verify findings, reports, and audit trails in the database
 *
 * Covers all 4 consumption modes:
 * - API (api-consumer): REST API testing via programmatic-feedback
 * - CLI (cli-expert): CLI testing via programmatic-feedback
 * - GUI (gui-tester): Web UI testing via playwright-feedback
 * - SDK (sdk-developer): SDK testing via programmatic-feedback
 *
 * Requirements:
 * - `claude` CLI installed
 * - MCP servers built (npm run build in packages/mcp-servers)
 * - Playwright browsers installed for GUI tests (npx playwright install chromium)
 *
 * Run: npx vitest run --config tests/e2e/vitest.config.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import { randomUUID } from 'crypto';

import { checkTestCapabilities } from './helpers/prerequisites.js';
import { createTestProject, type TestProject } from './helpers/project-factory.js';
import { getSessionResults } from './helpers/result-verifier.js';
import { startToyApp, type ToyAppInstance } from '../integration/helpers/toy-app-runner.js';

// Import feedback launcher functions (ESM .js from hooks dir)
// These are the real launcher functions, not stubs
const launcherPath = path.resolve(__dirname, '../../.claude/hooks/feedback-launcher.js');

let getPersona: (personaId: string, projectDir?: string) => Promise<unknown>;
let generateMcpConfig: (sessionId: string, persona: unknown, projectDir?: string) => string;
let buildPrompt: (persona: unknown, sessionId: string) => string;
let runFeedbackAgent: (
  mcpConfigPath: string, prompt: string, sessionId: string, personaName: string,
  options?: { projectDir?: string; timeout?: number; model?: string }
) => Promise<{ exitCode: number; stdout: string; stderr: string; pid: number }>;
let cleanupOldConfigs: () => void;

let skip = false;
let playwrightAvailable = false;

describe('Feedback System E2E (Real Claude Agents)', () => {
  let toyApp: ToyAppInstance;
  let testProject: TestProject;

  beforeAll(async () => {
    // Check prerequisites first
    const capabilities = await checkTestCapabilities();
    skip = capabilities.skip;
    playwrightAvailable = capabilities.playwrightAvailable;
    if (skip) return;

    // Import launcher dynamically (it's an ESM JS file)
    try {
      const launcher = await import(launcherPath);
      getPersona = launcher.getPersona;
      generateMcpConfig = launcher.generateMcpConfig;
      buildPrompt = launcher.buildPrompt;
      runFeedbackAgent = launcher.runFeedbackAgent;
      cleanupOldConfigs = launcher.cleanupOldConfigs;
    } catch (err) {
      console.warn(`Failed to import feedback-launcher: ${err}`);
      skip = true;
      return;
    }

    // Start toy app
    toyApp = await startToyApp();

    // Create test project with all 4 persona types
    testProject = createTestProject({
      personas: [
        {
          name: 'api-consumer',
          description: 'A developer testing the REST API. Methodical, checks status codes, validates response bodies.',
          consumption_mode: 'api',
          behavior_traits: ['methodical', 'checks status codes', 'validates response bodies'],
          endpoints: [`${toyApp.baseUrl}/api`],
        },
        {
          name: 'cli-expert',
          description: 'A CLI power user who expects proper help docs and error messages.',
          consumption_mode: 'cli',
          behavior_traits: ['tries --help first', 'tests edge cases', 'checks error messages'],
          endpoints: [`node ${path.resolve(__dirname, '../fixtures/toy-app/cli.js')} --api-url=${toyApp.baseUrl}`],
        },
        {
          name: 'gui-tester',
          description: 'A non-technical user who clicks through the web UI. Expects clear visual feedback, intuitive navigation, and no broken links.',
          consumption_mode: 'gui',
          behavior_traits: ['clicks every link', 'tries wrong passwords', 'looks for visual feedback', 'checks navigation'],
          endpoints: [`${toyApp.baseUrl}`],
        },
        {
          name: 'sdk-developer',
          description: 'A developer integrating the SDK into their application. Reads exports, tests each function, validates return types and error handling.',
          consumption_mode: 'sdk',
          behavior_traits: ['reads API surface first', 'tests edge cases', 'checks return types', 'validates error messages'],
          endpoints: [path.resolve(__dirname, '../fixtures/toy-app/lib.cjs')],
        },
      ],
      features: [
        { name: 'task-api', description: 'REST API for task CRUD', file_patterns: ['**/api/**', 'server.js'] },
        { name: 'cli-interface', description: 'CLI tool', file_patterns: ['cli.js', '**/cli/**'] },
        { name: 'web-ui', description: 'Web interface for task management', file_patterns: ['server.js', '**/views/**'] },
        { name: 'task-sdk', description: 'SDK for programmatic task management', file_patterns: ['lib.cjs', '**/sdk/**'] },
      ],
      mappings: [
        {
          persona_name: 'api-consumer', feature_name: 'task-api', priority: 'high',
          test_scenarios: ['List tasks', 'Create task and verify status code', 'Update task', 'Delete task'],
        },
        {
          persona_name: 'cli-expert', feature_name: 'cli-interface', priority: 'high',
          test_scenarios: ['Run --help', 'List tasks', 'Create and complete a task'],
        },
        {
          persona_name: 'gui-tester', feature_name: 'web-ui', priority: 'high',
          test_scenarios: ['Log in with correct credentials', 'Try wrong password and check for error message', 'Navigate to settings', 'Click privacy policy link', 'Create and delete a task'],
        },
        {
          persona_name: 'sdk-developer', feature_name: 'task-sdk', priority: 'high',
          test_scenarios: ['List exports', 'Create a task', 'Get a task by ID', 'Delete a task', 'Test error handling for invalid inputs'],
        },
      ],
    });
  }, 30000);

  afterAll(async () => {
    if (toyApp) await toyApp.stop();
    if (testProject) testProject.cleanup();
    if (cleanupOldConfigs) cleanupOldConfigs();
  }, 10000);

  // ==========================================================================
  // Launcher Unit Tests (fast, no Claude needed)
  // ==========================================================================

  describe('Launcher Functions', () => {
    it('should read persona with features from DB', async () => {
      if (skip) return;

      const personaId = testProject.getPersonaId('api-consumer');
      const persona = await getPersona(personaId, testProject.dir) as {
        name: string;
        consumption_mode: string;
        behavior_traits: string[];
        features: Array<{ name: string; test_scenarios: string[] }>;
      };

      expect(persona.name).toBe('api-consumer');
      expect(persona.consumption_mode).toBe('api');
      expect(persona.behavior_traits).toContain('methodical');
      expect(persona.features).toHaveLength(1);
      expect(persona.features[0].name).toBe('task-api');
      expect(persona.features[0].test_scenarios).toContain('List tasks');
    });

    it('should generate valid MCP config with correct server paths', async () => {
      if (skip) return;

      const personaId = testProject.getPersonaId('api-consumer');
      const persona = await getPersona(personaId, testProject.dir);
      const sessionId = randomUUID();

      const configPath = generateMcpConfig(sessionId, persona, testProject.dir);

      // Config file should exist on disk
      const fs = await import('fs');
      expect(fs.existsSync(configPath)).toBe(true);

      // Parse and validate
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
        mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
      };

      // Should have programmatic-feedback and feedback-reporter
      expect(config.mcpServers['programmatic-feedback']).toBeDefined();
      expect(config.mcpServers['feedback-reporter']).toBeDefined();

      // Verify env vars
      const pfEnv = config.mcpServers['programmatic-feedback'].env;
      expect(pfEnv.FEEDBACK_MODE).toBe('api');
      expect(pfEnv.FEEDBACK_SESSION_ID).toBe(sessionId);

      // Should NOT have project MCP servers (isolation)
      expect(config.mcpServers['todo-db']).toBeUndefined();
      expect(config.mcpServers['specs-browser']).toBeUndefined();
      expect(config.mcpServers['deputy-cto']).toBeUndefined();

      // Clean up
      fs.unlinkSync(configPath);
    });

    it('should generate GUI MCP config with playwright-feedback server', async () => {
      if (skip) return;

      const personaId = testProject.getPersonaId('gui-tester');
      const persona = await getPersona(personaId, testProject.dir);
      const sessionId = randomUUID();

      const configPath = generateMcpConfig(sessionId, persona, testProject.dir);

      const fs = await import('fs');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
        mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
      };

      // GUI mode should have playwright-feedback, NOT programmatic-feedback
      expect(config.mcpServers['playwright-feedback']).toBeDefined();
      expect(config.mcpServers['programmatic-feedback']).toBeUndefined();
      expect(config.mcpServers['feedback-reporter']).toBeDefined();

      // Verify base URL is set
      const pwEnv = config.mcpServers['playwright-feedback'].env;
      expect(pwEnv.FEEDBACK_BASE_URL).toContain('http://localhost');
      expect(pwEnv.FEEDBACK_BROWSER_HEADLESS).toBe('true');

      fs.unlinkSync(configPath);
    });

    it('should generate SDK MCP config with programmatic-feedback in sdk mode', async () => {
      if (skip) return;

      const personaId = testProject.getPersonaId('sdk-developer');
      const persona = await getPersona(personaId, testProject.dir);
      const sessionId = randomUUID();

      const configPath = generateMcpConfig(sessionId, persona, testProject.dir);

      const fs = await import('fs');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
        mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
      };

      // SDK mode should have programmatic-feedback with sdk mode
      expect(config.mcpServers['programmatic-feedback']).toBeDefined();
      expect(config.mcpServers['feedback-reporter']).toBeDefined();

      const pfEnv = config.mcpServers['programmatic-feedback'].env;
      expect(pfEnv.FEEDBACK_MODE).toBe('sdk');
      expect(pfEnv.FEEDBACK_SDK_PACKAGES).toContain('lib.cjs');

      fs.unlinkSync(configPath);
    });

    it('should build persona-specific prompt with traits and scenarios', async () => {
      if (skip) return;

      const personaId = testProject.getPersonaId('api-consumer');
      const persona = await getPersona(personaId, testProject.dir);
      const sessionId = randomUUID();

      const prompt = buildPrompt(persona as Parameters<typeof buildPrompt>[0], sessionId);

      expect(prompt).toContain('api-consumer');
      expect(prompt).toContain('methodical');
      expect(prompt).toContain('List tasks');
      expect(prompt).toContain('Create task and verify status code');
      expect(prompt).toContain(sessionId);
      expect(prompt).toContain('submit_finding');
      expect(prompt).toContain('You are NOT a developer');
    });
  });

  // ==========================================================================
  // Real Claude Agent Tests (slow, opt-in)
  // ==========================================================================

  describe('API Persona Session', () => {
    it('should spawn API persona, interact with toy app, and produce findings', async () => {
      if (skip) return;

      const sessionId = randomUUID();
      const personaId = testProject.getPersonaId('api-consumer');

      // Use REAL launcher functions
      const persona = await getPersona(personaId, testProject.dir);
      const mcpConfigPath = generateMcpConfig(sessionId, persona, testProject.dir);
      const prompt = buildPrompt(persona as Parameters<typeof buildPrompt>[0], sessionId);

      // Spawn REAL Claude agent (awaitable)
      const result = await runFeedbackAgent(mcpConfigPath, prompt, sessionId, 'api-consumer', {
        projectDir: testProject.dir,
        timeout: 180000, // 3 min
      });

      expect(result.exitCode).toBe(0);

      // Verify session produced results
      const results = getSessionResults(testProject.dir, sessionId, 'api-consumer');

      // Claude should have found SOMETHING (non-deterministic what)
      expect(results.findings.length).toBeGreaterThan(0);

      // Reports should be in agent-reports DB
      expect(results.reports.length).toBeGreaterThan(0);
      expect(results.reports.every(r => r.category === 'user-feedback')).toBe(true);
      expect(results.reports.every(r => r.reporting_agent === 'feedback-api-consumer')).toBe(true);

      // Audit trail should exist (AuditedMcpServer logged tool calls)
      expect(results.auditEvents.length).toBeGreaterThan(0);
    }, 240000); // 4 min timeout
  });

  describe('CLI Persona Session', () => {
    it('should spawn CLI persona, test CLI, and produce findings', async () => {
      if (skip) return;

      const sessionId = randomUUID();
      const personaId = testProject.getPersonaId('cli-expert');

      const persona = await getPersona(personaId, testProject.dir);
      const mcpConfigPath = generateMcpConfig(sessionId, persona, testProject.dir);
      const prompt = buildPrompt(persona as Parameters<typeof buildPrompt>[0], sessionId);

      const result = await runFeedbackAgent(mcpConfigPath, prompt, sessionId, 'cli-expert', {
        projectDir: testProject.dir,
        timeout: 180000,
      });

      expect(result.exitCode).toBe(0);

      const results = getSessionResults(testProject.dir, sessionId, 'cli-expert');

      expect(results.findings.length).toBeGreaterThan(0);
      expect(results.reports.length).toBeGreaterThan(0);
      expect(results.reports.every(r => r.reporting_agent === 'feedback-cli-expert')).toBe(true);
    }, 240000);
  });

  describe('GUI Persona Session', () => {
    it('should spawn GUI persona, test web UI with Playwright, and produce findings', async (ctx) => {
      if (skip) return;
      if (!playwrightAvailable) {
        ctx.skip();
        return;
      }

      const sessionId = randomUUID();
      const personaId = testProject.getPersonaId('gui-tester');

      const persona = await getPersona(personaId, testProject.dir);
      const mcpConfigPath = generateMcpConfig(sessionId, persona, testProject.dir);
      const prompt = buildPrompt(persona as Parameters<typeof buildPrompt>[0], sessionId);

      const result = await runFeedbackAgent(mcpConfigPath, prompt, sessionId, 'gui-tester', {
        projectDir: testProject.dir,
        timeout: 300000, // 5 min — browser operations are slower
      });

      expect(result.exitCode).toBe(0);

      const results = getSessionResults(testProject.dir, sessionId, 'gui-tester');

      expect(results.findings.length).toBeGreaterThan(0);
      expect(results.reports.length).toBeGreaterThan(0);
      expect(results.reports.every(r => r.reporting_agent === 'feedback-gui-tester')).toBe(true);

      // Audit trail should exist
      expect(results.auditEvents.length).toBeGreaterThan(0);
    }, 360000); // 6 min timeout
  });

  describe('SDK Persona Session', () => {
    it('should spawn SDK persona, test SDK module, and produce findings', async () => {
      if (skip) return;

      const sessionId = randomUUID();
      const personaId = testProject.getPersonaId('sdk-developer');

      const persona = await getPersona(personaId, testProject.dir);
      const mcpConfigPath = generateMcpConfig(sessionId, persona, testProject.dir);
      const prompt = buildPrompt(persona as Parameters<typeof buildPrompt>[0], sessionId);

      const result = await runFeedbackAgent(mcpConfigPath, prompt, sessionId, 'sdk-developer', {
        projectDir: testProject.dir,
        timeout: 180000, // 3 min
      });

      expect(result.exitCode).toBe(0);

      const results = getSessionResults(testProject.dir, sessionId, 'sdk-developer');

      expect(results.findings.length).toBeGreaterThan(0);
      expect(results.reports.length).toBeGreaterThan(0);
      expect(results.reports.every(r => r.reporting_agent === 'feedback-sdk-developer')).toBe(true);

      // Audit trail should exist
      expect(results.auditEvents.length).toBeGreaterThan(0);
    }, 240000); // 4 min timeout
  });

  describe('Full Pipeline (Multi-Persona)', () => {
    it('should run multiple persona sessions and verify cross-persona reports', async () => {
      if (skip) return;

      // Always include api, cli, sdk. Conditionally include gui.
      const personaNames = ['api-consumer', 'cli-expert', 'sdk-developer'];
      if (playwrightAvailable) {
        personaNames.push('gui-tester');
      }

      // Run all personas in parallel
      const promises = personaNames.map(async (personaName) => {
        const sessionId = randomUUID();
        const personaId = testProject.getPersonaId(personaName);

        const persona = await getPersona(personaId, testProject.dir);
        const mcpConfigPath = generateMcpConfig(sessionId, persona, testProject.dir);
        const prompt = buildPrompt(persona as Parameters<typeof buildPrompt>[0], sessionId);

        return runFeedbackAgent(mcpConfigPath, prompt, sessionId, personaName, {
          projectDir: testProject.dir,
          timeout: 300000, // 5 min per agent
        });
      });

      const results = await Promise.allSettled(promises);

      // At least two must succeed to verify cross-persona behavior
      const fulfilled = results.filter(r => r.status === 'fulfilled');
      expect(fulfilled.length).toBeGreaterThanOrEqual(2);

      // Check cross-persona reports
      const Database = (await import('better-sqlite3')).default;
      const reportsDb = new Database(testProject.reportsDbPath, { readonly: true });

      interface ReportRow { reporting_agent: string; category: string; }
      const allReports = reportsDb.prepare('SELECT reporting_agent, category FROM reports').all() as ReportRow[];
      reportsDb.close();

      expect(allReports.length).toBeGreaterThan(0);
      expect(allReports.every(r => r.category === 'user-feedback')).toBe(true);

      // Should have reports from multiple personas (consistent with requiring 2+ successes)
      const agents = [...new Set(allReports.map(r => r.reporting_agent))];
      expect(agents.length).toBeGreaterThan(1);
    }, 900000); // 15 min for all concurrent sessions
  });
});
