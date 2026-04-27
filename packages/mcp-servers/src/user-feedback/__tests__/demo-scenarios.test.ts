/**
 * Unit tests for Demo Scenario CRUD on User Feedback MCP Server
 *
 * Tests create, update, delete, list, get operations,
 * consumption_mode validation, and .demo.ts suffix enforcement.
 *
 * Uses in-memory SQLite database for complete test isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
  createTestDb,
  createTempDir,
  isErrorResult,
} from '../../__testUtils__/index.js';
import {
  USER_FEEDBACK_SCHEMA,
} from '../../__testUtils__/schemas.js';
import { EXTRA_ENV_BLOCKED_PREFIXES } from '../../playwright/helpers.js';

// ============================================================================
// Database Row Types
// ============================================================================

interface ScenarioRow {
  id: string;
  persona_id: string;
  title: string;
  description: string;
  category: string | null;
  playwright_project: string;
  test_file: string;
  sort_order: number;
  enabled: number;
  headed: number;
  remote_eligible: number;
  stealth_required: number;
  dual_instance: number;
  created_at: string;
  created_timestamp: string;
  updated_at: string;
  last_recorded_at: string | null;
  recording_path: string | null;
  env_vars: string | null;
}

interface ScenarioResult {
  id: string;
  persona_id: string;
  title: string;
  description: string;
  category: string | null;
  playwright_project: string;
  test_file: string;
  sort_order: number;
  enabled: boolean;
  headed: boolean;
  remote_eligible: boolean;
  stealth_required: boolean;
  dual_instance: boolean;
  created_at: string;
  updated_at: string;
  persona_name?: string;
  last_recorded_at: string | null;
  recording_path: string | null;
  env_vars: Record<string, string> | null;
}

interface ErrorResult {
  error: string;
}

// ============================================================================
// Blocked env_vars prefix list (mirrors server implementation)
// ============================================================================

const ENV_VARS_BLOCKED_PREFIXES = [
  'PATH', 'HOME', 'USER', 'SHELL',
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_',
  'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ACCESS_TOKEN',
  'GITHUB_TOKEN', 'CLOUDFLARE_', 'CODECOV_', 'RESEND_',
  'OP_SERVICE_ACCOUNT_TOKEN', 'GENTYR_',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY',
  'DEMO_SLOW_MO', 'DEMO_PAUSE_AT_END', 'DEMO_HEADLESS',
  'DEMO_SHOW_CURSOR', 'DEMO_PROGRESS_FILE', 'DEMO_RECORD_VIDEO', 'DEMO_MAXIMIZE',
  'PLAYWRIGHT_BASE_URL', 'CLAUDE_',
];

function validateScenarioEnvVars(envVars: Record<string, string>): string | null {
  const keys = Object.keys(envVars);
  if (keys.length > 25) return 'env_vars: max 25 keys allowed';
  const blocked = keys.filter(k =>
    ENV_VARS_BLOCKED_PREFIXES.some(prefix => k === prefix || k.startsWith(prefix)),
  );
  if (blocked.length > 0) return `env_vars: blocked keys: ${blocked.join(', ')}`;
  return null;
}

function resolveMainProjectDir(projectDir: string): string {
  try {
    const gitPath = path.join(projectDir, '.git');
    const stat = fs.statSync(gitPath);
    if (stat.isFile()) {
      const content = fs.readFileSync(gitPath, 'utf-8');
      const match = content.match(/gitdir:\s*(.+)/);
      if (match) {
        const gitDir = path.resolve(projectDir, match[1].trim());
        return path.resolve(gitDir, '..', '..', '..');
      }
    }
  } catch { /* not a worktree */ }
  const worktreeMarker = `${path.sep}.claude${path.sep}worktrees${path.sep}`;
  const idx = projectDir.indexOf(worktreeMarker);
  if (idx !== -1) {
    return projectDir.substring(0, idx);
  }
  return projectDir;
}

type DiscoverResult =
  | { status: 'discovered'; names: string[] }
  | { status: 'no-config' }
  | { status: 'error'; message: string };

function discoverProjectNames(projectDir: string): DiscoverResult {
  try {
    const resolvedDir = resolveMainProjectDir(projectDir);
    const configPath = path.join(resolvedDir, 'playwright.config.ts');
    const content = fs.readFileSync(configPath, 'utf-8');
    const names: string[] = [];
    const re = /name:\s*['"]([^'"]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      names.push(match[1]);
    }
    return { status: 'discovered', names };
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'no-config' };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'error', message: `Failed to read playwright.config.ts: ${msg}` };
  }
}

// ============================================================================
// Helper Functions (mirror server implementation)
// ============================================================================

function createPersona(db: Database.Database, args: {
  name: string;
  description: string;
  consumption_mode: string | string[];
}) {
  const id = randomUUID();
  const now = new Date();
  const created_at = now.toISOString();
  const created_timestamp = now.toISOString();
  const modes = Array.isArray(args.consumption_mode) ? args.consumption_mode : [args.consumption_mode];

  db.prepare(`
    INSERT INTO personas (id, name, description, consumption_modes, behavior_traits, endpoints, created_at, created_timestamp, updated_at)
    VALUES (?, ?, ?, ?, '[]', '[]', ?, ?, ?)
  `).run(id, args.name, args.description, JSON.stringify(modes), created_at, created_timestamp, created_at);

  return { id, name: args.name, consumption_modes: modes };
}

function scenarioToResult(row: ScenarioRow & { persona_name?: string }): ScenarioResult {
  let envVars: Record<string, string> | null = null;
  if (row.env_vars) {
    try { envVars = JSON.parse(row.env_vars); } catch { /* invalid JSON, treat as null */ }
  }
  return {
    id: row.id,
    persona_id: row.persona_id,
    title: row.title,
    description: row.description,
    category: row.category,
    playwright_project: row.playwright_project,
    test_file: row.test_file,
    sort_order: row.sort_order,
    enabled: row.enabled === 1,
    headed: row.headed === 1,
    remote_eligible: row.remote_eligible === 1,
    stealth_required: row.stealth_required === 1,
    dual_instance: row.dual_instance === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_recorded_at: row.last_recorded_at ?? null,
    recording_path: row.recording_path ?? null,
    env_vars: envVars,
    ...(row.persona_name ? { persona_name: row.persona_name } : {}),
  };
}

function createScenario(db: Database.Database, args: {
  persona_id: string;
  title: string;
  description: string;
  category?: string;
  playwright_project: string;
  test_file: string;
  sort_order?: number;
  headed?: boolean;
  remote_eligible?: boolean;
  stealth_required?: boolean;
  dual_instance?: boolean;
  env_vars?: Record<string, string>;
}, projectDir?: string): ScenarioResult | ErrorResult {
  // Validate persona exists and includes 'gui' or 'adk' in consumption_modes
  const persona = db.prepare('SELECT id, name, consumption_modes FROM personas WHERE id = ?')
    .get(args.persona_id) as { id: string; name: string; consumption_modes: string } | undefined;

  if (!persona) {
    return { error: `Persona not found: ${args.persona_id}` };
  }
  const personaModes = JSON.parse(persona.consumption_modes) as string[];
  if (!personaModes.includes('gui') && !personaModes.includes('adk')) {
    return {
      error: `Demo scenarios require a GUI or ADK persona. Persona "${persona.name}" has consumption_modes ${JSON.stringify(personaModes)}. Only personas that include "gui" or "adk" in consumption_modes can have demo scenarios.`,
    };
  }
  if (!args.test_file.endsWith('.demo.ts')) {
    return { error: `test_file must end with ".demo.ts" — got "${args.test_file}"` };
  }

  if (projectDir) {
    const discovered = discoverProjectNames(projectDir);
    if (discovered.status === 'error') {
      return { error: discovered.message };
    }
    if (discovered.status === 'discovered' && !discovered.names.includes(args.playwright_project)) {
      return { error: `Invalid playwright_project "${args.playwright_project}". Valid projects: ${discovered.names.join(', ')}` };
    }
  }

  if (args.env_vars) {
    const envError = validateScenarioEnvVars(args.env_vars);
    if (envError) return { error: envError };
  }

  const id = randomUUID();
  const now = new Date();
  const created_at = now.toISOString();
  const created_timestamp = now.toISOString();

  try {
    db.prepare(`
      INSERT INTO demo_scenarios (id, persona_id, title, description, category, playwright_project, test_file, sort_order, enabled, headed, remote_eligible, stealth_required, dual_instance, created_at, created_timestamp, updated_at, env_vars)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, args.persona_id, args.title, args.description,
      args.category ?? null, args.playwright_project, args.test_file,
      args.sort_order ?? 0,
      args.headed ? 1 : 0,
      args.remote_eligible === false ? 0 : 1,
      args.stealth_required ? 1 : 0,
      args.dual_instance ? 1 : 0,
      created_at, created_timestamp, created_at,
      args.env_vars ? JSON.stringify(args.env_vars) : null,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('UNIQUE constraint')) {
      return { error: `A scenario with test_file "${args.test_file}" already exists` };
    }
    return { error: `Failed: ${message}` };
  }

  const row = db.prepare(`
    SELECT ds.*, p.name as persona_name
    FROM demo_scenarios ds
    JOIN personas p ON p.id = ds.persona_id
    WHERE ds.id = ?
  `).get(id) as (ScenarioRow & { persona_name: string });

  return scenarioToResult(row);
}

function updateScenario(db: Database.Database, args: {
  id: string;
  title?: string;
  description?: string;
  category?: string;
  playwright_project?: string;
  test_file?: string;
  sort_order?: number;
  enabled?: boolean;
  headed?: boolean;
  remote_eligible?: boolean;
  stealth_required?: boolean;
  dual_instance?: boolean;
  env_vars?: Record<string, string> | null;
}, projectDir?: string): ScenarioResult | ErrorResult {
  const existing = db.prepare('SELECT id FROM demo_scenarios WHERE id = ?').get(args.id);
  if (!existing) {
    return { error: `Scenario not found: ${args.id}` };
  }

  if (args.test_file && !args.test_file.endsWith('.demo.ts')) {
    return { error: `test_file must end with ".demo.ts" — got "${args.test_file}"` };
  }

  if (args.playwright_project !== undefined && projectDir) {
    const discovered = discoverProjectNames(projectDir);
    if (discovered.status === 'error') {
      return { error: discovered.message };
    }
    if (discovered.status === 'discovered' && !discovered.names.includes(args.playwright_project)) {
      return { error: `Invalid playwright_project "${args.playwright_project}". Valid projects: ${discovered.names.join(', ')}` };
    }
  }

  const updates: string[] = [];
  const values: unknown[] = [];

  if (args.title !== undefined) { updates.push('title = ?'); values.push(args.title); }
  if (args.description !== undefined) { updates.push('description = ?'); values.push(args.description); }
  if (args.category !== undefined) { updates.push('category = ?'); values.push(args.category); }
  if (args.playwright_project !== undefined) { updates.push('playwright_project = ?'); values.push(args.playwright_project); }
  if (args.test_file !== undefined) { updates.push('test_file = ?'); values.push(args.test_file); }
  if (args.sort_order !== undefined) { updates.push('sort_order = ?'); values.push(args.sort_order); }
  if (args.enabled !== undefined) { updates.push('enabled = ?'); values.push(args.enabled ? 1 : 0); }
  if (args.headed !== undefined) { updates.push('headed = ?'); values.push(args.headed ? 1 : 0); }
  if (args.remote_eligible !== undefined) { updates.push('remote_eligible = ?'); values.push(args.remote_eligible ? 1 : 0); }
  if (args.stealth_required !== undefined) { updates.push('stealth_required = ?'); values.push(args.stealth_required ? 1 : 0); }
  if (args.dual_instance !== undefined) { updates.push('dual_instance = ?'); values.push(args.dual_instance ? 1 : 0); }
  if (args.env_vars !== undefined) {
    if (args.env_vars === null) {
      updates.push('env_vars = ?'); values.push(null);
    } else {
      const envError = validateScenarioEnvVars(args.env_vars);
      if (envError) {
        return { error: envError };
      }
      updates.push('env_vars = ?'); values.push(JSON.stringify(args.env_vars));
    }
  }

  if (updates.length === 0) {
    return { error: 'No fields to update' };
  }

  updates.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(args.id);

  db.prepare(`UPDATE demo_scenarios SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  const row = db.prepare(`
    SELECT ds.*, p.name as persona_name
    FROM demo_scenarios ds
    JOIN personas p ON p.id = ds.persona_id
    WHERE ds.id = ?
  `).get(args.id) as (ScenarioRow & { persona_name: string });

  return scenarioToResult(row);
}

function deleteScenario(db: Database.Database, id: string): { deleted: boolean } | ErrorResult {
  const result = db.prepare('DELETE FROM demo_scenarios WHERE id = ?').run(id);
  if (result.changes === 0) {
    return { error: `Scenario not found: ${id}` };
  }
  return { deleted: true };
}

function listScenarios(db: Database.Database, args: {
  persona_id?: string;
  enabled_only?: boolean;
  category?: string;
  limit?: number;
}): ScenarioResult[] {
  let query = `
    SELECT ds.*, p.name as persona_name
    FROM demo_scenarios ds
    JOIN personas p ON p.id = ds.persona_id
    WHERE 1=1
  `;
  const params: unknown[] = [];

  if (args.persona_id) { query += ' AND ds.persona_id = ?'; params.push(args.persona_id); }
  if (args.enabled_only !== false) { query += ' AND ds.enabled = 1'; }
  if (args.category) { query += ' AND ds.category = ?'; params.push(args.category); }

  query += ' ORDER BY p.name, ds.sort_order';
  query += ` LIMIT ${args.limit ?? 50}`;

  const rows = db.prepare(query).all(...params) as (ScenarioRow & { persona_name: string })[];
  return rows.map(scenarioToResult);
}

function getScenario(db: Database.Database, id: string): ScenarioResult | ErrorResult {
  const row = db.prepare(`
    SELECT ds.*, p.name as persona_name
    FROM demo_scenarios ds
    JOIN personas p ON p.id = ds.persona_id
    WHERE ds.id = ?
  `).get(id) as (ScenarioRow & { persona_name: string }) | undefined;

  if (!row) {
    return { error: `Scenario not found: ${id}` };
  }
  return scenarioToResult(row);
}

// ============================================================================
// Tests
// ============================================================================

describe('Demo Scenario CRUD', () => {
  let db: Database.Database;
  let guiPersona: { id: string; name: string };
  let apiPersona: { id: string; name: string };

  beforeEach(() => {
    db = createTestDb(USER_FEEDBACK_SCHEMA);
    guiPersona = createPersona(db, {
      name: 'test-gui-user',
      description: 'A GUI persona for testing',
      consumption_mode: 'gui',
    });
    apiPersona = createPersona(db, {
      name: 'test-api-user',
      description: 'An API persona for testing',
      consumption_mode: 'api',
    });
  });

  afterEach(() => {
    db.close();
  });

  // ============================================================================
  // create_scenario
  // ============================================================================

  describe('create_scenario', () => {
    it('should create a scenario for a GUI persona', () => {
      const result = createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Onboarding Flow',
        description: 'Walk through the onboarding wizard',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/onboarding.demo.ts',
      });

      expect(isErrorResult(result)).toBe(false);
      if (!isErrorResult(result)) {
        expect(result.title).toBe('Onboarding Flow');
        expect(result.persona_id).toBe(guiPersona.id);
        expect(result.playwright_project).toBe('vendor-owner');
        expect(result.test_file).toBe('e2e/demo/onboarding.demo.ts');
        expect(result.enabled).toBe(true);
        expect(result.sort_order).toBe(0);
        expect(result.persona_name).toBe('test-gui-user');
      }
    });

    it('should default headed to false and remote_eligible to true', () => {
      const result = createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Default Flags Flow',
        description: 'Verifies default values for headed and remote_eligible',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/default-flags.demo.ts',
      });

      expect(isErrorResult(result)).toBe(false);
      if (!isErrorResult(result)) {
        expect(result.headed).toBe(false);
        expect(result.remote_eligible).toBe(true);
      }
    });

    it('should create a headed scenario with remote_eligible=false', () => {
      const result = createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Headed Only Flow',
        description: 'Requires window recording',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/headed-only.demo.ts',
        headed: true,
        remote_eligible: false,
      });

      expect(isErrorResult(result)).toBe(false);
      if (!isErrorResult(result)) {
        expect(result.headed).toBe(true);
        expect(result.remote_eligible).toBe(false);
      }
    });

    it('should create a non-headed scenario explicitly marked remote_eligible=false', () => {
      const result = createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Chrome Bridge Flow',
        description: 'Uses chrome-bridge extension socket',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/ext-chrome-bridge.demo.ts',
        headed: false,
        remote_eligible: false,
      });

      expect(isErrorResult(result)).toBe(false);
      if (!isErrorResult(result)) {
        expect(result.headed).toBe(false);
        expect(result.remote_eligible).toBe(false);
      }
    });

    it('should reject persona with no gui or adk mode', () => {
      const result = createScenario(db, {
        persona_id: apiPersona.id,
        title: 'API Flow',
        description: 'Test API flow',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/api-flow.demo.ts',
      });

      expect(isErrorResult(result)).toBe(true);
      if (isErrorResult(result)) {
        expect(result.error).toContain('Demo scenarios require a GUI or ADK persona');
        expect(result.error).toContain('"api"');
      }
    });

    it('should reject non-existent persona', () => {
      const result = createScenario(db, {
        persona_id: 'non-existent-id',
        title: 'Ghost Flow',
        description: 'Test flow',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/ghost.demo.ts',
      });

      expect(isErrorResult(result)).toBe(true);
      if (isErrorResult(result)) {
        expect(result.error).toContain('Persona not found');
      }
    });

    it('should enforce .demo.ts suffix on test_file', () => {
      const result = createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Bad Suffix',
        description: 'Test flow',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/flow.spec.ts',
      });

      expect(isErrorResult(result)).toBe(true);
      if (isErrorResult(result)) {
        expect(result.error).toContain('.demo.ts');
      }
    });

    it('should reject duplicate test_file', () => {
      createScenario(db, {
        persona_id: guiPersona.id,
        title: 'First Flow',
        description: 'First',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/unique.demo.ts',
      });

      const result = createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Second Flow',
        description: 'Second',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/unique.demo.ts',
      });

      expect(isErrorResult(result)).toBe(true);
      if (isErrorResult(result)) {
        expect(result.error).toContain('already exists');
      }
    });

    it('should accept optional category and sort_order', () => {
      const result = createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Billing Flow',
        description: 'Walk through billing',
        category: 'billing',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/billing.demo.ts',
        sort_order: 5,
      });

      expect(isErrorResult(result)).toBe(false);
      if (!isErrorResult(result)) {
        expect(result.category).toBe('billing');
        expect(result.sort_order).toBe(5);
      }
    });

    it('should reject cli, api, and sdk-only consumption modes', () => {
      // Only gui and adk are accepted; cli, api, and sdk-only personas are rejected
      const modes = ['cli', 'api', 'sdk'];
      for (const mode of modes) {
        const persona = createPersona(db, {
          name: `rejection-test-${mode}-user`,
          description: `A ${mode} persona`,
          consumption_mode: mode,
        });

        const result = createScenario(db, {
          persona_id: persona.id,
          title: `${mode} Flow`,
          description: 'Test flow',
          playwright_project: 'vendor-owner',
          test_file: `e2e/demo/${mode}-flow.demo.ts`,
        });

        expect(isErrorResult(result)).toBe(true);
        if (isErrorResult(result)) {
          expect(result.error).toContain(`"${mode}"`);
        }
      }
    });

    it('should allow scenario for multi-mode persona that includes gui', () => {
      const multiModePersona = createPersona(db, {
        name: 'sdk-gui-user',
        description: 'An SDK+GUI persona',
        consumption_mode: ['sdk', 'gui'],
      });

      const result = createScenario(db, {
        persona_id: multiModePersona.id,
        title: 'Multi-Mode Flow',
        description: 'Test multi-mode flow',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/multi-mode-flow.demo.ts',
      });

      expect(isErrorResult(result)).toBe(false);
      if (!isErrorResult(result)) {
        expect(result.title).toBe('Multi-Mode Flow');
        expect(result.persona_name).toBe('sdk-gui-user');
      }
    });

    it('should allow scenario for an ADK persona', () => {
      const adkPersona = createPersona(db, {
        name: 'adk-agent-user',
        description: 'An ADK persona',
        consumption_mode: 'adk',
      });

      const result = createScenario(db, {
        persona_id: adkPersona.id,
        title: 'ADK Flow',
        description: 'Test ADK flow',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/adk-flow.demo.ts',
      });

      expect(isErrorResult(result)).toBe(false);
      if (!isErrorResult(result)) {
        expect(result.title).toBe('ADK Flow');
        expect(result.persona_name).toBe('adk-agent-user');
      }
    });

    it('should create scenario with env_vars and return them as a parsed object', () => {
      const result = createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Env Vars Flow',
        description: 'Tests env_vars injection',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/env-vars.demo.ts',
        env_vars: { AZURE_DEMO: '1', FEATURE_FLAG: 'enabled' },
      });

      expect(isErrorResult(result)).toBe(false);
      if (!isErrorResult(result)) {
        expect(result.env_vars).not.toBeNull();
        expect(typeof result.env_vars).toBe('object');
        expect(result.env_vars!['AZURE_DEMO']).toBe('1');
        expect(result.env_vars!['FEATURE_FLAG']).toBe('enabled');
      }
    });

    it('should return env_vars as null when not provided', () => {
      const result = createScenario(db, {
        persona_id: guiPersona.id,
        title: 'No Env Vars Flow',
        description: 'No env_vars',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/no-env-vars.demo.ts',
      });

      expect(isErrorResult(result)).toBe(false);
      if (!isErrorResult(result)) {
        expect(result.env_vars).toBeNull();
      }
    });

    it('should reject env_vars with more than 25 keys', () => {
      const tooManyVars: Record<string, string> = {};
      for (let i = 0; i < 26; i++) {
        tooManyVars[`KEY_${i}`] = `value_${i}`;
      }

      const result = createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Too Many Vars',
        description: 'Too many env vars',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/too-many-vars.demo.ts',
        env_vars: tooManyVars,
      });

      expect(isErrorResult(result)).toBe(true);
      if (isErrorResult(result)) {
        expect(result.error).toContain('env_vars: max 25 keys allowed');
      }
    });

    it('should accept env_vars with exactly 25 keys', () => {
      const exactlyVars: Record<string, string> = {};
      for (let i = 0; i < 25; i++) {
        exactlyVars[`KEY_${i}`] = `value_${i}`;
      }

      const result = createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Exactly 25 Vars',
        description: 'Exactly 25 env vars',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/twentyfive-vars.demo.ts',
        env_vars: exactlyVars,
      });

      expect(isErrorResult(result)).toBe(false);
      if (!isErrorResult(result)) {
        expect(result.env_vars).not.toBeNull();
        expect(Object.keys(result.env_vars!)).toHaveLength(25);
      }
    });

    it('should reject env_vars with blocked key prefixes', () => {
      const result = createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Blocked Keys',
        description: 'Has blocked env var keys',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/blocked-keys.demo.ts',
        env_vars: { NODE_OPTIONS: '--require /tmp/evil.js' },
      });

      expect(isErrorResult(result)).toBe(true);
      if (isErrorResult(result)) {
        expect(result.error).toContain('blocked keys');
        expect(result.error).toContain('NODE_OPTIONS');
      }
    });

    it('should reject env_vars with SUPABASE_SERVICE_ROLE_KEY (dangerous credential)', () => {
      const result = createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Blocked Service Key',
        description: 'Tries to set service role key',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/blocked-srk.demo.ts',
        env_vars: { SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGciOiJIUzI1NiJ9.secret' },
      });

      expect(isErrorResult(result)).toBe(true);
      if (isErrorResult(result)) {
        expect(result.error).toContain('blocked keys');
        expect(result.error).toContain('SUPABASE_SERVICE_ROLE_KEY');
      }
    });

    it('should reject env_vars with SUPABASE_ACCESS_TOKEN (management API credential)', () => {
      const result = createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Blocked Access Token',
        description: 'Tries to set access token',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/blocked-sat.demo.ts',
        env_vars: { SUPABASE_ACCESS_TOKEN: 'sbp_secret' },
      });

      expect(isErrorResult(result)).toBe(true);
      if (isErrorResult(result)) {
        expect(result.error).toContain('blocked keys');
        expect(result.error).toContain('SUPABASE_ACCESS_TOKEN');
      }
    });

    it('should accept env_vars with SUPABASE_URL (non-secret identifier)', () => {
      const result = createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Supabase URL OK',
        description: 'Non-secret project URL is allowed',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/supabase-url.demo.ts',
        env_vars: { SUPABASE_URL: 'http://localhost:54321' },
      });

      expect(isErrorResult(result)).toBe(false);
      if (!isErrorResult(result)) {
        expect(result.env_vars).toEqual({ SUPABASE_URL: 'http://localhost:54321' });
      }
    });

    it('should accept env_vars with DATABASE_URL (non-secret connection string)', () => {
      const result = createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Database URL OK',
        description: 'Non-secret connection string is allowed',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/database-url.demo.ts',
        env_vars: { DATABASE_URL: 'postgres://localhost/dev' },
      });

      expect(isErrorResult(result)).toBe(false);
      if (!isErrorResult(result)) {
        expect(result.env_vars).toEqual({ DATABASE_URL: 'postgres://localhost/dev' });
      }
    });

    it('should accept env_vars with NEXT_PUBLIC_SUPABASE_URL (non-secret public identifier)', () => {
      const result = createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Next Public URL OK',
        description: 'Frontend public URL is allowed',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/next-public-url.demo.ts',
        env_vars: { NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321' },
      });

      expect(isErrorResult(result)).toBe(false);
      if (!isErrorResult(result)) {
        expect(result.env_vars).toEqual({ NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321' });
      }
    });

    it('should reject env_vars with DEMO_ prefix keys', () => {
      const result = createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Demo Override',
        description: 'Tries to override demo env vars',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/demo-override.demo.ts',
        env_vars: { DEMO_HEADLESS: '0' },
      });

      expect(isErrorResult(result)).toBe(true);
      if (isErrorResult(result)) {
        expect(result.error).toContain('blocked keys');
      }
    });

    describe('playwright_project validation', () => {
      // Locate the host project root via CLAUDE_PROJECT_DIR (set by MCP server) or by
      // walking up from process.cwd() until we find playwright.config.ts.
      // When running tests outside a host project context, this resolves to undefined
      // and the config-dependent tests are skipped.
      function findHostProjectDir(): string | undefined {
        const fromEnv = process.env['CLAUDE_PROJECT_DIR'];
        if (fromEnv && fs.existsSync(path.join(fromEnv, 'playwright.config.ts'))) {
          return fromEnv;
        }
        let dir = process.cwd();
        while (dir !== path.dirname(dir)) {
          if (fs.existsSync(path.join(dir, 'playwright.config.ts'))) {
            return dir;
          }
          dir = path.dirname(dir);
        }
        return undefined;
      }

      it('should reject invalid playwright_project when config exists', () => {
        const hostProjectDir = findHostProjectDir();
        if (!hostProjectDir) {
          // playwright.config.ts not found in this execution context — skip
          return;
        }
        const result = createScenario(db, {
          persona_id: guiPersona.id,
          title: 'Invalid Project',
          description: 'Test invalid project',
          playwright_project: 'nonexistent-project',
          test_file: 'e2e/demo/invalid-project.demo.ts',
        }, hostProjectDir);

        expect(isErrorResult(result)).toBe(true);
        if (isErrorResult(result)) {
          expect(result.error).toContain('Invalid playwright_project');
          expect(result.error).toContain('nonexistent-project');
          expect(result.error).toContain('Valid projects');
        }
      });

      it('should accept valid playwright_project when config exists', () => {
        const hostProjectDir = findHostProjectDir();
        if (!hostProjectDir) {
          // playwright.config.ts not found in this execution context — skip
          return;
        }
        const result = createScenario(db, {
          persona_id: guiPersona.id,
          title: 'Valid Project',
          description: 'Test valid project',
          playwright_project: 'demo',
          test_file: 'e2e/demo/valid-project.demo.ts',
        }, hostProjectDir);

        expect(isErrorResult(result)).toBe(false);
      });

      it('should skip validation when playwright.config.ts is missing', () => {
        const result = createScenario(db, {
          persona_id: guiPersona.id,
          title: 'No Config',
          description: 'Test missing config',
          playwright_project: 'anything-goes',
          test_file: 'e2e/demo/no-config.demo.ts',
        }, '/tmp/nonexistent-dir-12345');

        // Should succeed because discoverProjectNames returns { status: 'no-config' } for missing config
        expect(isErrorResult(result)).toBe(false);
      });
    });
  });

  // ============================================================================
  // update_scenario
  // ============================================================================

  describe('update_scenario', () => {
    it('should partially update a scenario', () => {
      const created = createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Original Title',
        description: 'Original description',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/original.demo.ts',
      });
      expect(isErrorResult(created)).toBe(false);
      if (isErrorResult(created)) return;

      const updated = updateScenario(db, {
        id: created.id,
        title: 'Updated Title',
      });

      expect(isErrorResult(updated)).toBe(false);
      if (!isErrorResult(updated)) {
        expect(updated.title).toBe('Updated Title');
        expect(updated.description).toBe('Original description');
      }
    });

    it('should enforce .demo.ts suffix on test_file update', () => {
      const created = createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Flow',
        description: 'Desc',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/flow.demo.ts',
      });
      expect(isErrorResult(created)).toBe(false);
      if (isErrorResult(created)) return;

      const result = updateScenario(db, {
        id: created.id,
        test_file: 'e2e/demo/flow.spec.ts',
      });

      expect(isErrorResult(result)).toBe(true);
    });

    it('should return error for non-existent scenario', () => {
      const result = updateScenario(db, {
        id: 'non-existent',
        title: 'Nope',
      });

      expect(isErrorResult(result)).toBe(true);
      if (isErrorResult(result)) {
        expect(result.error).toContain('Scenario not found');
      }
    });

    it('should toggle enabled state', () => {
      const created = createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Toggle Test',
        description: 'Desc',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/toggle.demo.ts',
      });
      expect(isErrorResult(created)).toBe(false);
      if (isErrorResult(created)) return;

      const disabled = updateScenario(db, { id: created.id, enabled: false });
      expect(isErrorResult(disabled)).toBe(false);
      if (!isErrorResult(disabled)) {
        expect(disabled.enabled).toBe(false);
      }

      const enabled = updateScenario(db, { id: created.id, enabled: true });
      expect(isErrorResult(enabled)).toBe(false);
      if (!isErrorResult(enabled)) {
        expect(enabled.enabled).toBe(true);
      }
    });

    it('should set env_vars on a scenario that had none', () => {
      const created = createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Env Update Test',
        description: 'Desc',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/env-update.demo.ts',
      });
      expect(isErrorResult(created)).toBe(false);
      if (isErrorResult(created)) return;
      expect((created as ScenarioResult).env_vars).toBeNull();

      const updated = updateScenario(db, {
        id: (created as ScenarioResult).id,
        env_vars: { MY_FLAG: 'true' },
      });

      expect(isErrorResult(updated)).toBe(false);
      if (!isErrorResult(updated)) {
        expect(updated.env_vars).not.toBeNull();
        expect(updated.env_vars!['MY_FLAG']).toBe('true');
      }
    });

    it('should clear env_vars when updated to null', () => {
      const created = createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Env Clear Test',
        description: 'Desc',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/env-clear.demo.ts',
        env_vars: { SOME_VAR: 'value' },
      });
      expect(isErrorResult(created)).toBe(false);
      if (isErrorResult(created)) return;

      const cleared = updateScenario(db, {
        id: (created as ScenarioResult).id,
        env_vars: null,
      });

      expect(isErrorResult(cleared)).toBe(false);
      if (!isErrorResult(cleared)) {
        expect(cleared.env_vars).toBeNull();
      }
    });

    it('should reject env_vars update with more than 25 keys', () => {
      const created = createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Env Max Keys Update',
        description: 'Desc',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/env-max-keys.demo.ts',
      });
      expect(isErrorResult(created)).toBe(false);
      if (isErrorResult(created)) return;

      const tooManyVars: Record<string, string> = {};
      for (let i = 0; i < 26; i++) {
        tooManyVars[`KEY_${i}`] = `value_${i}`;
      }

      const result = updateScenario(db, {
        id: (created as ScenarioResult).id,
        env_vars: tooManyVars,
      });

      expect(isErrorResult(result)).toBe(true);
      if (isErrorResult(result)) {
        expect(result.error).toContain('env_vars: max 25 keys allowed');
      }
    });

    it('should preserve existing env_vars when updating other fields', () => {
      const created = createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Preserve Env Test',
        description: 'Desc',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/preserve-env.demo.ts',
        env_vars: { KEEP_ME: 'yes' },
      });
      expect(isErrorResult(created)).toBe(false);
      if (isErrorResult(created)) return;

      const updated = updateScenario(db, {
        id: (created as ScenarioResult).id,
        title: 'Updated Title',
      });

      expect(isErrorResult(updated)).toBe(false);
      if (!isErrorResult(updated)) {
        expect(updated.title).toBe('Updated Title');
        expect(updated.env_vars).not.toBeNull();
        expect(updated.env_vars!['KEEP_ME']).toBe('yes');
      }
    });

    it('should update headed and remote_eligible flags independently', () => {
      const created = createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Flag Update Test',
        description: 'Verifies headed and remote_eligible updates',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/flag-update.demo.ts',
      });
      expect(isErrorResult(created)).toBe(false);
      if (isErrorResult(created)) return;
      expect((created as ScenarioResult).headed).toBe(false);
      expect((created as ScenarioResult).remote_eligible).toBe(true);

      const updated = updateScenario(db, {
        id: created.id,
        headed: true,
        remote_eligible: false,
      });

      expect(isErrorResult(updated)).toBe(false);
      if (!isErrorResult(updated)) {
        expect(updated.headed).toBe(true);
        expect(updated.remote_eligible).toBe(false);
        // Other fields must be preserved
        expect(updated.title).toBe('Flag Update Test');
        expect(updated.enabled).toBe(true);
      }
    });

    it('should allow clearing headed=false and re-enabling remote_eligible=true', () => {
      const created = createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Flag Clear Test',
        description: 'Verifies clearing headed/remote_eligible back to defaults',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/flag-clear.demo.ts',
        headed: true,
        remote_eligible: false,
      });
      expect(isErrorResult(created)).toBe(false);
      if (isErrorResult(created)) return;

      const restored = updateScenario(db, {
        id: created.id,
        headed: false,
        remote_eligible: true,
      });

      expect(isErrorResult(restored)).toBe(false);
      if (!isErrorResult(restored)) {
        expect(restored.headed).toBe(false);
        expect(restored.remote_eligible).toBe(true);
      }
    });

    it('should preserve headed and remote_eligible when updating other fields', () => {
      const created = createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Preserve Flags Test',
        description: 'Verifies flags are not reset on unrelated updates',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/preserve-flags.demo.ts',
        headed: true,
        remote_eligible: false,
      });
      expect(isErrorResult(created)).toBe(false);
      if (isErrorResult(created)) return;

      const updated = updateScenario(db, {
        id: created.id,
        title: 'Preserve Flags Test — Updated Title',
      });

      expect(isErrorResult(updated)).toBe(false);
      if (!isErrorResult(updated)) {
        expect(updated.title).toBe('Preserve Flags Test — Updated Title');
        expect(updated.headed).toBe(true);
        expect(updated.remote_eligible).toBe(false);
      }
    });

    it('should reject invalid playwright_project on update when config exists', () => {
      // Locate the host project root via CLAUDE_PROJECT_DIR or by walking up from cwd.
      // When running outside a host project context, this test is a no-op.
      const fromEnv = process.env['CLAUDE_PROJECT_DIR'];
      let hostProjectDir: string | undefined;
      if (fromEnv && fs.existsSync(path.join(fromEnv, 'playwright.config.ts'))) {
        hostProjectDir = fromEnv;
      } else {
        let dir = process.cwd();
        while (dir !== path.dirname(dir)) {
          if (fs.existsSync(path.join(dir, 'playwright.config.ts'))) {
            hostProjectDir = dir;
            break;
          }
          dir = path.dirname(dir);
        }
      }
      if (!hostProjectDir) return;

      const created = createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Update Project Test',
        description: 'Desc',
        playwright_project: 'demo',
        test_file: 'e2e/demo/update-project.demo.ts',
      }, hostProjectDir);
      expect(isErrorResult(created)).toBe(false);
      if (isErrorResult(created)) return;

      const result = updateScenario(db, {
        id: created.id,
        playwright_project: 'nonexistent-project',
      }, hostProjectDir);

      expect(isErrorResult(result)).toBe(true);
      if (isErrorResult(result)) {
        expect(result.error).toContain('Invalid playwright_project');
        expect(result.error).toContain('nonexistent-project');
      }
    });
  });

  // ============================================================================
  // delete_scenario
  // ============================================================================

  describe('delete_scenario', () => {
    it('should delete an existing scenario', () => {
      const created = createScenario(db, {
        persona_id: guiPersona.id,
        title: 'To Delete',
        description: 'Desc',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/delete-me.demo.ts',
      });
      expect(isErrorResult(created)).toBe(false);
      if (isErrorResult(created)) return;

      const result = deleteScenario(db, created.id);
      expect(isErrorResult(result)).toBe(false);

      const check = getScenario(db, created.id);
      expect(isErrorResult(check)).toBe(true);
    });

    it('should return error for non-existent scenario', () => {
      const result = deleteScenario(db, 'non-existent');
      expect(isErrorResult(result)).toBe(true);
    });
  });

  // ============================================================================
  // list_scenarios
  // ============================================================================

  describe('list_scenarios', () => {
    it('should list all enabled scenarios', () => {
      createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Flow A',
        description: 'Desc',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/flow-a.demo.ts',
        sort_order: 1,
      });
      createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Flow B',
        description: 'Desc',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/flow-b.demo.ts',
        sort_order: 2,
      });

      const results = listScenarios(db, {});
      expect(results).toHaveLength(2);
      expect(results[0].title).toBe('Flow A');
      expect(results[1].title).toBe('Flow B');
    });

    it('should filter by persona_id', () => {
      const secondGui = createPersona(db, {
        name: 'second-gui-user',
        description: 'Another GUI persona',
        consumption_mode: 'gui',
      });

      createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Flow A',
        description: 'Desc',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/a.demo.ts',
      });
      createScenario(db, {
        persona_id: secondGui.id,
        title: 'Flow B',
        description: 'Desc',
        playwright_project: 'vendor-admin',
        test_file: 'e2e/demo/b.demo.ts',
      });

      const results = listScenarios(db, { persona_id: secondGui.id });
      expect(results).toHaveLength(1);
      expect(results[0].persona_name).toBe('second-gui-user');
    });

    it('should filter by category', () => {
      createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Onboarding',
        description: 'Desc',
        category: 'onboarding',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/onb.demo.ts',
      });
      createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Billing',
        description: 'Desc',
        category: 'billing',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/bill.demo.ts',
      });

      const results = listScenarios(db, { category: 'billing' });
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Billing');
    });

    it('should exclude disabled scenarios when enabled_only is true', () => {
      const created = createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Disabled Flow',
        description: 'Desc',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/disabled.demo.ts',
      });
      expect(isErrorResult(created)).toBe(false);
      if (!isErrorResult(created)) {
        updateScenario(db, { id: created.id, enabled: false });
      }

      createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Enabled Flow',
        description: 'Desc',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/enabled.demo.ts',
      });

      const results = listScenarios(db, { enabled_only: true });
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Enabled Flow');
    });

    it('should include disabled scenarios when enabled_only is false', () => {
      const created = createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Disabled Flow',
        description: 'Desc',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/dis.demo.ts',
      });
      expect(isErrorResult(created)).toBe(false);
      if (!isErrorResult(created)) {
        updateScenario(db, { id: created.id, enabled: false });
      }

      createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Enabled Flow',
        description: 'Desc',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/en.demo.ts',
      });

      const results = listScenarios(db, { enabled_only: false });
      expect(results).toHaveLength(2);
    });

    it('should respect limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        createScenario(db, {
          persona_id: guiPersona.id,
          title: `Flow ${i}`,
          description: 'Desc',
          playwright_project: 'vendor-owner',
          test_file: `e2e/demo/flow-${i}.demo.ts`,
          sort_order: i,
        });
      }

      const results = listScenarios(db, { limit: 3 });
      expect(results).toHaveLength(3);
    });
  });

  // ============================================================================
  // get_scenario
  // ============================================================================

  describe('get_scenario', () => {
    it('should return scenario with persona_name', () => {
      const created = createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Get Me',
        description: 'Desc',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/get-me.demo.ts',
      });
      expect(isErrorResult(created)).toBe(false);
      if (isErrorResult(created)) return;

      const result = getScenario(db, created.id);
      expect(isErrorResult(result)).toBe(false);
      if (!isErrorResult(result)) {
        expect(result.title).toBe('Get Me');
        expect(result.persona_name).toBe('test-gui-user');
        expect(result.enabled).toBe(true);
        expect(typeof result.headed).toBe('boolean');
        expect(typeof result.remote_eligible).toBe('boolean');
        expect(typeof result.stealth_required).toBe('boolean');
        expect(typeof result.dual_instance).toBe('boolean');
        expect(result.headed).toBe(false);
        expect(result.remote_eligible).toBe(true);
        expect(result.stealth_required).toBe(false);
        expect(result.dual_instance).toBe(false);
      }
    });

    it('should return error for non-existent scenario', () => {
      const result = getScenario(db, 'non-existent');
      expect(isErrorResult(result)).toBe(true);
      if (isErrorResult(result)) {
        expect(result.error).toContain('Scenario not found');
      }
    });
  });

  // ============================================================================
  // CASCADE behavior
  // ============================================================================

  describe('CASCADE on persona delete', () => {
    it('should delete scenarios when persona is deleted', () => {
      const created = createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Cascade Test',
        description: 'Desc',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/cascade.demo.ts',
      });
      expect(isErrorResult(created)).toBe(false);
      if (isErrorResult(created)) return;

      // Delete the persona
      db.prepare('DELETE FROM personas WHERE id = ?').run(guiPersona.id);

      // Scenario should be gone
      const row = db.prepare('SELECT id FROM demo_scenarios WHERE id = ?').get(created.id);
      expect(row).toBeUndefined();
    });
  });

  // ============================================================================
  // Steel fields: stealth_required and dual_instance
  // ============================================================================

  describe('stealth_required and dual_instance fields', () => {
    it('should default stealth_required to false and dual_instance to false', () => {
      const result = createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Default Steel Fields',
        description: 'Verifies Steel field defaults',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/default-steel.demo.ts',
      });

      expect(isErrorResult(result)).toBe(false);
      if (!isErrorResult(result)) {
        expect(result.stealth_required).toBe(false);
        expect(result.dual_instance).toBe(false);
      }
    });

    it('should create a scenario with stealth_required=true', () => {
      const result = createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Stealth Required Flow',
        description: 'Routes to Steel.dev for anti-bot stealth',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/stealth-required.demo.ts',
        stealth_required: true,
      });

      expect(isErrorResult(result)).toBe(false);
      if (!isErrorResult(result)) {
        expect(result.stealth_required).toBe(true);
        expect(result.dual_instance).toBe(false);
      }
    });

    it('should create a scenario with dual_instance=true', () => {
      const result = createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Dual Instance Flow',
        description: 'Fly.io + Steel in parallel',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/dual-instance.demo.ts',
        dual_instance: true,
      });

      expect(isErrorResult(result)).toBe(false);
      if (!isErrorResult(result)) {
        expect(result.stealth_required).toBe(false);
        expect(result.dual_instance).toBe(true);
      }
    });

    it('should update stealth_required and dual_instance independently', () => {
      const created = createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Steel Update Test',
        description: 'Verifies Steel field updates',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/steel-update.demo.ts',
      });
      expect(isErrorResult(created)).toBe(false);
      if (isErrorResult(created)) return;
      expect((created as ScenarioResult).stealth_required).toBe(false);
      expect((created as ScenarioResult).dual_instance).toBe(false);

      const updated = updateScenario(db, {
        id: created.id,
        stealth_required: true,
        dual_instance: true,
      });

      expect(isErrorResult(updated)).toBe(false);
      if (!isErrorResult(updated)) {
        expect(updated.stealth_required).toBe(true);
        expect(updated.dual_instance).toBe(true);
        // Other fields must be preserved
        expect(updated.title).toBe('Steel Update Test');
        expect(updated.enabled).toBe(true);
      }
    });

    it('should preserve stealth_required and dual_instance when updating other fields', () => {
      const created = createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Preserve Steel Flags',
        description: 'Verifies Steel flags are not reset on unrelated updates',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/preserve-steel.demo.ts',
        stealth_required: true,
        dual_instance: true,
      });
      expect(isErrorResult(created)).toBe(false);
      if (isErrorResult(created)) return;

      const updated = updateScenario(db, {
        id: created.id,
        title: 'Preserve Steel Flags — Updated',
      });

      expect(isErrorResult(updated)).toBe(false);
      if (!isErrorResult(updated)) {
        expect(updated.title).toBe('Preserve Steel Flags — Updated');
        expect(updated.stealth_required).toBe(true);
        expect(updated.dual_instance).toBe(true);
      }
    });

    it('should clear stealth_required and dual_instance back to false', () => {
      const created = createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Steel Clear Test',
        description: 'Verifies clearing Steel flags back to defaults',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/steel-clear.demo.ts',
        stealth_required: true,
        dual_instance: true,
      });
      expect(isErrorResult(created)).toBe(false);
      if (isErrorResult(created)) return;

      const cleared = updateScenario(db, {
        id: created.id,
        stealth_required: false,
        dual_instance: false,
      });

      expect(isErrorResult(cleared)).toBe(false);
      if (!isErrorResult(cleared)) {
        expect(cleared.stealth_required).toBe(false);
        expect(cleared.dual_instance).toBe(false);
      }
    });
  });

  // ============================================================================
  // discoverProjectNames — discriminated union (G001 fail-closed)
  // ============================================================================

  describe('discoverProjectNames', () => {
    it('should return { status: "no-config" } for a directory with no playwright.config.ts', () => {
      // A dir that definitely does not contain playwright.config.ts
      const tempDir = createTempDir('discover-no-config');
      try {
        const result = discoverProjectNames(tempDir.path);
        expect(result.status).toBe('no-config');
      } finally {
        tempDir.cleanup();
      }
    });

    it('should return { status: "no-config" } for a completely nonexistent directory', () => {
      const result = discoverProjectNames('/tmp/nonexistent-playwright-dir-zzzz99999');
      expect(result.status).toBe('no-config');
    });

    it('should return { status: "discovered", names: [...] } for a valid playwright.config.ts', () => {
      const tempDir = createTempDir('discover-valid-config');
      try {
        const configContent = `
import { defineConfig } from '@playwright/test';
export default defineConfig({
  projects: [
    { name: 'vendor-owner', use: {} },
    { name: 'vendor-admin', use: {} },
    { name: 'demo', use: {} },
  ],
});
`;
        fs.writeFileSync(path.join(tempDir.path, 'playwright.config.ts'), configContent);

        const result = discoverProjectNames(tempDir.path);
        expect(result.status).toBe('discovered');
        if (result.status === 'discovered') {
          expect(Array.isArray(result.names)).toBe(true);
          expect(result.names).toContain('vendor-owner');
          expect(result.names).toContain('vendor-admin');
          expect(result.names).toContain('demo');
          expect(result.names).toHaveLength(3);
        }
      } finally {
        tempDir.cleanup();
      }
    });

    it('should return { status: "error" } for an unreadable playwright.config.ts (G001 fail-closed)', () => {
      // chmod 000 only denies access for non-root processes
      if (process.getuid && process.getuid() === 0) {
        // Running as root — skip: root bypasses file permission checks
        return;
      }

      const tempDir = createTempDir('discover-unreadable');
      try {
        const configPath = path.join(tempDir.path, 'playwright.config.ts');
        fs.writeFileSync(configPath, 'export default {};');
        fs.chmodSync(configPath, 0o000);

        const result = discoverProjectNames(tempDir.path);
        expect(result.status).toBe('error');
        if (result.status === 'error') {
          expect(typeof result.message).toBe('string');
          expect(result.message.length).toBeGreaterThan(0);
          expect(result.message).toContain('playwright.config.ts');
        }
      } finally {
        // Restore permissions so cleanup() can delete the file
        try {
          fs.chmodSync(path.join(tempDir.path, 'playwright.config.ts'), 0o644);
        } catch { /* best-effort */ }
        tempDir.cleanup();
      }
    });
  });

  // ============================================================================
  // createScenario / updateScenario — fail-closed on config error (G001)
  // ============================================================================

  describe('fail-closed on unreadable playwright.config.ts (G001)', () => {
    it('createScenario should return { error } when playwright.config.ts is unreadable', () => {
      if (process.getuid && process.getuid() === 0) {
        return;
      }

      const tempDir = createTempDir('create-unreadable');
      try {
        const configPath = path.join(tempDir.path, 'playwright.config.ts');
        fs.writeFileSync(configPath, 'export default {};');
        fs.chmodSync(configPath, 0o000);

        const result = createScenario(db, {
          persona_id: guiPersona.id,
          title: 'Unreadable Config Flow',
          description: 'Should be rejected due to unreadable config',
          playwright_project: 'vendor-owner',
          test_file: 'e2e/demo/unreadable-config.demo.ts',
        }, tempDir.path);

        // G001: must fail-closed — return an error, never silently accept
        expect(isErrorResult(result)).toBe(true);
        if (isErrorResult(result)) {
          expect(result.error).toContain('playwright.config.ts');
        }
      } finally {
        try {
          fs.chmodSync(path.join(tempDir.path, 'playwright.config.ts'), 0o644);
        } catch { /* best-effort */ }
        tempDir.cleanup();
      }
    });

    it('updateScenario should return { error } when playwright.config.ts is unreadable', () => {
      if (process.getuid && process.getuid() === 0) {
        return;
      }

      // Create a valid scenario first (no projectDir = no config validation at creation time)
      const created = createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Update Unreadable Config Flow',
        description: 'Will be updated with an unreadable config dir',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/update-unreadable-config.demo.ts',
      });
      expect(isErrorResult(created)).toBe(false);
      if (isErrorResult(created)) return;

      const tempDir = createTempDir('update-unreadable');
      try {
        const configPath = path.join(tempDir.path, 'playwright.config.ts');
        fs.writeFileSync(configPath, 'export default {};');
        fs.chmodSync(configPath, 0o000);

        const result = updateScenario(db, {
          id: created.id,
          // Changing playwright_project triggers discoverProjectNames
          playwright_project: 'vendor-admin',
        }, tempDir.path);

        // G001: must fail-closed — return an error, never silently accept
        expect(isErrorResult(result)).toBe(true);
        if (isErrorResult(result)) {
          expect(result.error).toContain('playwright.config.ts');
        }
      } finally {
        try {
          fs.chmodSync(path.join(tempDir.path, 'playwright.config.ts'), 0o644);
        } catch { /* best-effort */ }
        tempDir.cleanup();
      }
    });
  });
});

// ============================================================================
// Cross-reference: blocklist parity between playwright/helpers.ts and
// user-feedback/server.ts. Both maintain identical blocked prefix lists.
// This test catches silent divergence that previously required manual review.
// ============================================================================

describe('env_vars blocklist parity', () => {
  it('should have ENV_VARS_BLOCKED_PREFIXES identical to EXTRA_ENV_BLOCKED_PREFIXES from playwright/helpers.ts', () => {
    // ENV_VARS_BLOCKED_PREFIXES is the local test fixture mirroring the
    // inline constant in user-feedback/server.ts. If either list changes
    // without updating the other, this test fails.
    const sorted = (arr: string[]) => [...arr].sort();
    expect(sorted(ENV_VARS_BLOCKED_PREFIXES)).toEqual(sorted(EXTRA_ENV_BLOCKED_PREFIXES));
  });
});
