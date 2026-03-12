/**
 * Unit tests for Demo Prerequisite CRUD on User Feedback MCP Server
 *
 * Tests register, update, delete, list operations,
 * scope constraint validation, and CASCADE behavior.
 *
 * Uses in-memory SQLite database for complete test isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

import {
  createTestDb,
  isErrorResult,
} from '../../__testUtils__/index.js';
import {
  USER_FEEDBACK_SCHEMA,
} from '../../__testUtils__/schemas.js';

// ============================================================================
// Database Row Types
// ============================================================================

interface PrerequisiteRow {
  id: string;
  command: string;
  description: string;
  timeout_ms: number;
  health_check: string | null;
  health_check_timeout_ms: number;
  scope: string;
  persona_id: string | null;
  scenario_id: string | null;
  sort_order: number;
  enabled: number;
  run_as_background: number;
  created_at: string;
  created_timestamp: string;
  updated_at: string;
}

interface PrerequisiteResult {
  id: string;
  command: string;
  description: string;
  timeout_ms: number;
  health_check: string | null;
  health_check_timeout_ms: number;
  scope: string;
  persona_id: string | null;
  scenario_id: string | null;
  sort_order: number;
  enabled: boolean;
  run_as_background: boolean;
  created_at: string;
  updated_at: string;
  persona_name?: string;
  scenario_title?: string;
}

interface ErrorResult {
  error: string;
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

function createScenario(db: Database.Database, args: {
  persona_id: string;
  title: string;
  description: string;
  playwright_project: string;
  test_file: string;
  sort_order?: number;
}) {
  const id = randomUUID();
  const now = new Date();
  const created_at = now.toISOString();
  const created_timestamp = now.toISOString();

  db.prepare(`
    INSERT INTO demo_scenarios (id, persona_id, title, description, category, playwright_project, test_file, sort_order, enabled, created_at, created_timestamp, updated_at)
    VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 1, ?, ?, ?)
  `).run(
    id, args.persona_id, args.title, args.description,
    args.playwright_project, args.test_file,
    args.sort_order ?? 0, created_at, created_timestamp, created_at,
  );

  return { id, title: args.title, persona_id: args.persona_id };
}

function prerequisiteToResult(
  row: PrerequisiteRow & { persona_name?: string | null; scenario_title?: string | null },
): PrerequisiteResult {
  return {
    id: row.id,
    command: row.command,
    description: row.description,
    timeout_ms: row.timeout_ms,
    health_check: row.health_check,
    health_check_timeout_ms: row.health_check_timeout_ms,
    scope: row.scope,
    persona_id: row.persona_id,
    scenario_id: row.scenario_id,
    sort_order: row.sort_order,
    enabled: row.enabled === 1,
    run_as_background: row.run_as_background === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(row.persona_name != null ? { persona_name: row.persona_name } : {}),
    ...(row.scenario_title != null ? { scenario_title: row.scenario_title } : {}),
  };
}

function registerPrerequisite(db: Database.Database, args: {
  command: string;
  description: string;
  timeout_ms?: number;
  health_check?: string;
  health_check_timeout_ms?: number;
  scope?: 'global' | 'persona' | 'scenario';
  persona_id?: string;
  scenario_id?: string;
  sort_order?: number;
  run_as_background?: boolean;
}): PrerequisiteResult | ErrorResult {
  const scope = args.scope ?? 'global';

  // Validate scope constraints
  if (scope === 'persona') {
    if (!args.persona_id) {
      return { error: 'persona_id is required when scope is "persona"' };
    }
    const persona = db.prepare('SELECT id, name FROM personas WHERE id = ?').get(args.persona_id) as { id: string; name: string } | undefined;
    if (!persona) {
      return { error: `Persona not found: ${args.persona_id}` };
    }
  } else if (scope === 'scenario') {
    if (!args.scenario_id) {
      return { error: 'scenario_id is required when scope is "scenario"' };
    }
    const scenario = db.prepare('SELECT id, title FROM demo_scenarios WHERE id = ?').get(args.scenario_id) as { id: string; title: string } | undefined;
    if (!scenario) {
      return { error: `Scenario not found: ${args.scenario_id}` };
    }
  } else {
    // scope === 'global' — persona_id and scenario_id must not be set
    if (args.persona_id) {
      return { error: 'persona_id must not be set when scope is "global"' };
    }
    if (args.scenario_id) {
      return { error: 'scenario_id must not be set when scope is "global"' };
    }
  }

  const id = randomUUID();
  const now = new Date();
  const created_at = now.toISOString();
  const created_timestamp = now.toISOString();

  try {
    db.prepare(`
      INSERT INTO demo_prerequisites (id, command, description, timeout_ms, health_check, health_check_timeout_ms, scope, persona_id, scenario_id, sort_order, enabled, run_as_background, created_at, created_timestamp, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    `).run(
      id,
      args.command,
      args.description,
      args.timeout_ms ?? 30000,
      args.health_check ?? null,
      args.health_check_timeout_ms ?? 5000,
      scope,
      args.persona_id ?? null,
      args.scenario_id ?? null,
      args.sort_order ?? 0,
      args.run_as_background ? 1 : 0,
      created_at,
      created_timestamp,
      created_at,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to register prerequisite: ${message}` };
  }

  const record = db.prepare('SELECT * FROM demo_prerequisites WHERE id = ?').get(id) as PrerequisiteRow;

  let personaName: string | undefined;
  if (record.persona_id) {
    const p = db.prepare('SELECT name FROM personas WHERE id = ?').get(record.persona_id) as { name: string } | undefined;
    personaName = p?.name;
  }
  let scenarioTitle: string | undefined;
  if (record.scenario_id) {
    const s = db.prepare('SELECT title FROM demo_scenarios WHERE id = ?').get(record.scenario_id) as { title: string } | undefined;
    scenarioTitle = s?.title;
  }

  return prerequisiteToResult({ ...record, persona_name: personaName ?? null, scenario_title: scenarioTitle ?? null });
}

function updatePrerequisite(db: Database.Database, args: {
  id: string;
  command?: string;
  description?: string;
  timeout_ms?: number;
  health_check?: string;
  health_check_timeout_ms?: number;
  sort_order?: number;
  enabled?: boolean;
  run_as_background?: boolean;
}): PrerequisiteResult | ErrorResult {
  const record = db.prepare('SELECT * FROM demo_prerequisites WHERE id = ?').get(args.id) as PrerequisiteRow | undefined;
  if (!record) {
    return { error: `Prerequisite not found: ${args.id}` };
  }

  const updates: string[] = [];
  const params: unknown[] = [];

  if (args.command !== undefined) { updates.push('command = ?'); params.push(args.command); }
  if (args.description !== undefined) { updates.push('description = ?'); params.push(args.description); }
  if (args.timeout_ms !== undefined) { updates.push('timeout_ms = ?'); params.push(args.timeout_ms); }
  if (args.health_check !== undefined) { updates.push('health_check = ?'); params.push(args.health_check); }
  if (args.health_check_timeout_ms !== undefined) { updates.push('health_check_timeout_ms = ?'); params.push(args.health_check_timeout_ms); }
  if (args.sort_order !== undefined) { updates.push('sort_order = ?'); params.push(args.sort_order); }
  if (args.enabled !== undefined) { updates.push('enabled = ?'); params.push(args.enabled ? 1 : 0); }
  if (args.run_as_background !== undefined) { updates.push('run_as_background = ?'); params.push(args.run_as_background ? 1 : 0); }

  if (updates.length === 0) {
    return { error: 'No fields to update' };
  }

  updates.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(args.id);

  try {
    db.prepare(`UPDATE demo_prerequisites SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to update prerequisite: ${message}` };
  }

  const updated = db.prepare('SELECT * FROM demo_prerequisites WHERE id = ?').get(args.id) as PrerequisiteRow;

  let personaName: string | undefined;
  if (updated.persona_id) {
    const p = db.prepare('SELECT name FROM personas WHERE id = ?').get(updated.persona_id) as { name: string } | undefined;
    personaName = p?.name;
  }
  let scenarioTitle: string | undefined;
  if (updated.scenario_id) {
    const s = db.prepare('SELECT title FROM demo_scenarios WHERE id = ?').get(updated.scenario_id) as { title: string } | undefined;
    scenarioTitle = s?.title;
  }

  return prerequisiteToResult({ ...updated, persona_name: personaName ?? null, scenario_title: scenarioTitle ?? null });
}

function deletePrerequisite(db: Database.Database, id: string): { deleted: boolean; message: string } | ErrorResult {
  const record = db.prepare('SELECT * FROM demo_prerequisites WHERE id = ?').get(id) as PrerequisiteRow | undefined;
  if (!record) {
    return { error: `Prerequisite not found: ${id}` };
  }
  db.prepare('DELETE FROM demo_prerequisites WHERE id = ?').run(id);
  return { deleted: true, message: `Prerequisite "${record.description}" deleted` };
}

function listPrerequisites(db: Database.Database, args: {
  scope?: 'global' | 'persona' | 'scenario';
  persona_id?: string;
  scenario_id?: string;
  enabled_only?: boolean;
}): { prerequisites: PrerequisiteResult[]; total: number } {
  let sql = `
    SELECT dp.*,
           p.name as persona_name,
           ds.title as scenario_title
    FROM demo_prerequisites dp
    LEFT JOIN personas p ON p.id = dp.persona_id
    LEFT JOIN demo_scenarios ds ON ds.id = dp.scenario_id
  `;
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (args.scope) {
    conditions.push('dp.scope = ?');
    params.push(args.scope);
  }
  if (args.persona_id) {
    conditions.push('dp.persona_id = ?');
    params.push(args.persona_id);
  }
  if (args.scenario_id) {
    conditions.push('dp.scenario_id = ?');
    params.push(args.scenario_id);
  }
  // enabled_only defaults to true when not specified (mirrors server's Zod default)
  if (args.enabled_only !== false) {
    conditions.push('dp.enabled = 1');
  }

  if (conditions.length > 0) {
    sql += ` WHERE ${conditions.join(' AND ')}`;
  }

  sql += ` ORDER BY CASE dp.scope WHEN 'global' THEN 1 WHEN 'persona' THEN 2 WHEN 'scenario' THEN 3 END, dp.sort_order ASC`;

  const records = db.prepare(sql).all(...params) as (PrerequisiteRow & { persona_name: string | null; scenario_title: string | null })[];

  return {
    prerequisites: records.map(r => prerequisiteToResult(r)),
    total: records.length,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Demo Prerequisite CRUD', () => {
  let db: Database.Database;
  let guiPersona: { id: string; name: string };
  let scenario: { id: string; title: string; persona_id: string };

  beforeEach(() => {
    db = createTestDb(USER_FEEDBACK_SCHEMA);
    guiPersona = createPersona(db, {
      name: 'test-gui-user',
      description: 'A GUI persona for testing',
      consumption_mode: 'gui',
    });
    scenario = createScenario(db, {
      persona_id: guiPersona.id,
      title: 'Onboarding Flow',
      description: 'Walk through the onboarding wizard',
      playwright_project: 'vendor-owner',
      test_file: 'e2e/demo/onboarding.demo.ts',
    });
  });

  afterEach(() => {
    db.close();
  });

  // ============================================================================
  // register_prerequisite
  // ============================================================================

  describe('register_prerequisite', () => {
    it('should register a global prerequisite with defaults', () => {
      const result = registerPrerequisite(db, {
        command: 'pnpm dev',
        description: 'Start the development server',
      });

      expect(isErrorResult(result)).toBe(false);
      if (!isErrorResult(result)) {
        expect(result.command).toBe('pnpm dev');
        expect(result.description).toBe('Start the development server');
        expect(result.scope).toBe('global');
        expect(result.timeout_ms).toBe(30000);
        expect(result.health_check_timeout_ms).toBe(5000);
        expect(result.health_check).toBeNull();
        expect(result.sort_order).toBe(0);
        expect(result.enabled).toBe(true);
        expect(result.run_as_background).toBe(false);
        expect(result.persona_id).toBeNull();
        expect(result.scenario_id).toBeNull();
        expect(result.persona_name).toBeUndefined();
        expect(result.scenario_title).toBeUndefined();
        expect(result.id).toBeTruthy();
        expect(result.created_at).toBeTruthy();
        expect(result.updated_at).toBeTruthy();
      }
    });

    it('should register with health_check and run_as_background', () => {
      const result = registerPrerequisite(db, {
        command: 'pnpm dev',
        description: 'Start the development server as background process',
        health_check: 'curl -sf http://localhost:3000/health',
        health_check_timeout_ms: 10000,
        timeout_ms: 60000,
        sort_order: 1,
        run_as_background: true,
      });

      expect(isErrorResult(result)).toBe(false);
      if (!isErrorResult(result)) {
        expect(result.health_check).toBe('curl -sf http://localhost:3000/health');
        expect(result.health_check_timeout_ms).toBe(10000);
        expect(result.timeout_ms).toBe(60000);
        expect(result.sort_order).toBe(1);
        expect(result.run_as_background).toBe(true);
      }
    });

    it('should register a persona-scoped prerequisite', () => {
      const result = registerPrerequisite(db, {
        command: 'pnpm seed:gui-user',
        description: 'Seed GUI user test data',
        scope: 'persona',
        persona_id: guiPersona.id,
      });

      expect(isErrorResult(result)).toBe(false);
      if (!isErrorResult(result)) {
        expect(result.scope).toBe('persona');
        expect(result.persona_id).toBe(guiPersona.id);
        expect(result.persona_name).toBe('test-gui-user');
        expect(result.scenario_id).toBeNull();
        expect(result.scenario_title).toBeUndefined();
      }
    });

    it('should register a scenario-scoped prerequisite', () => {
      const result = registerPrerequisite(db, {
        command: 'pnpm seed:onboarding',
        description: 'Seed onboarding test data',
        scope: 'scenario',
        scenario_id: scenario.id,
      });

      expect(isErrorResult(result)).toBe(false);
      if (!isErrorResult(result)) {
        expect(result.scope).toBe('scenario');
        expect(result.scenario_id).toBe(scenario.id);
        expect(result.scenario_title).toBe('Onboarding Flow');
        expect(result.persona_id).toBeNull();
        expect(result.persona_name).toBeUndefined();
      }
    });

    it('should reject persona scope without persona_id', () => {
      const result = registerPrerequisite(db, {
        command: 'pnpm seed',
        description: 'Missing persona_id',
        scope: 'persona',
      });

      expect(isErrorResult(result)).toBe(true);
      if (isErrorResult(result)) {
        expect(result.error).toContain('persona_id is required');
        expect(result.error).toContain('"persona"');
      }
    });

    it('should reject scenario scope without scenario_id', () => {
      const result = registerPrerequisite(db, {
        command: 'pnpm seed',
        description: 'Missing scenario_id',
        scope: 'scenario',
      });

      expect(isErrorResult(result)).toBe(true);
      if (isErrorResult(result)) {
        expect(result.error).toContain('scenario_id is required');
        expect(result.error).toContain('"scenario"');
      }
    });

    it('should reject persona scope with non-existent persona_id', () => {
      const result = registerPrerequisite(db, {
        command: 'pnpm seed',
        description: 'Ghost persona',
        scope: 'persona',
        persona_id: 'non-existent-persona-id',
      });

      expect(isErrorResult(result)).toBe(true);
      if (isErrorResult(result)) {
        expect(result.error).toContain('Persona not found');
        expect(result.error).toContain('non-existent-persona-id');
      }
    });

    it('should reject scenario scope with non-existent scenario_id', () => {
      const result = registerPrerequisite(db, {
        command: 'pnpm seed',
        description: 'Ghost scenario',
        scope: 'scenario',
        scenario_id: 'non-existent-scenario-id',
      });

      expect(isErrorResult(result)).toBe(true);
      if (isErrorResult(result)) {
        expect(result.error).toContain('Scenario not found');
        expect(result.error).toContain('non-existent-scenario-id');
      }
    });

    it('should reject global scope with persona_id set', () => {
      const result = registerPrerequisite(db, {
        command: 'pnpm dev',
        description: 'Global with unexpected persona_id',
        scope: 'global',
        persona_id: guiPersona.id,
      });

      expect(isErrorResult(result)).toBe(true);
      if (isErrorResult(result)) {
        expect(result.error).toContain('persona_id must not be set');
        expect(result.error).toContain('"global"');
      }
    });

    it('should reject global scope with scenario_id set', () => {
      const result = registerPrerequisite(db, {
        command: 'pnpm dev',
        description: 'Global with unexpected scenario_id',
        scope: 'global',
        scenario_id: scenario.id,
      });

      expect(isErrorResult(result)).toBe(true);
      if (isErrorResult(result)) {
        expect(result.error).toContain('scenario_id must not be set');
        expect(result.error).toContain('"global"');
      }
    });
  });

  // ============================================================================
  // update_prerequisite
  // ============================================================================

  describe('update_prerequisite', () => {
    it('should partially update a prerequisite', () => {
      const created = registerPrerequisite(db, {
        command: 'pnpm dev',
        description: 'Original description',
        timeout_ms: 30000,
      });
      expect(isErrorResult(created)).toBe(false);
      if (isErrorResult(created)) return;

      const updated = updatePrerequisite(db, {
        id: created.id,
        description: 'Updated description',
      });

      expect(isErrorResult(updated)).toBe(false);
      if (!isErrorResult(updated)) {
        expect(updated.description).toBe('Updated description');
        // Unchanged fields remain intact
        expect(updated.command).toBe('pnpm dev');
        expect(updated.timeout_ms).toBe(30000);
        expect(updated.scope).toBe('global');
      }
    });

    it('should update command, timeout_ms, and health_check together', () => {
      const created = registerPrerequisite(db, {
        command: 'pnpm dev',
        description: 'Dev server',
      });
      expect(isErrorResult(created)).toBe(false);
      if (isErrorResult(created)) return;

      const updated = updatePrerequisite(db, {
        id: created.id,
        command: 'pnpm start',
        timeout_ms: 60000,
        health_check: 'curl http://localhost:3000',
        health_check_timeout_ms: 8000,
      });

      expect(isErrorResult(updated)).toBe(false);
      if (!isErrorResult(updated)) {
        expect(updated.command).toBe('pnpm start');
        expect(updated.timeout_ms).toBe(60000);
        expect(updated.health_check).toBe('curl http://localhost:3000');
        expect(updated.health_check_timeout_ms).toBe(8000);
      }
    });

    it('should toggle enabled state off and on', () => {
      const created = registerPrerequisite(db, {
        command: 'pnpm dev',
        description: 'Toggle test',
      });
      expect(isErrorResult(created)).toBe(false);
      if (isErrorResult(created)) return;

      const disabled = updatePrerequisite(db, { id: created.id, enabled: false });
      expect(isErrorResult(disabled)).toBe(false);
      if (!isErrorResult(disabled)) {
        expect(disabled.enabled).toBe(false);
      }

      const reenabled = updatePrerequisite(db, { id: created.id, enabled: true });
      expect(isErrorResult(reenabled)).toBe(false);
      if (!isErrorResult(reenabled)) {
        expect(reenabled.enabled).toBe(true);
      }
    });

    it('should toggle run_as_background', () => {
      const created = registerPrerequisite(db, {
        command: 'pnpm dev',
        description: 'Background toggle test',
        run_as_background: false,
      });
      expect(isErrorResult(created)).toBe(false);
      if (isErrorResult(created)) return;

      const updated = updatePrerequisite(db, { id: created.id, run_as_background: true });
      expect(isErrorResult(updated)).toBe(false);
      if (!isErrorResult(updated)) {
        expect(updated.run_as_background).toBe(true);
      }
    });

    it('should return error for non-existent prerequisite', () => {
      const result = updatePrerequisite(db, {
        id: 'non-existent-id',
        description: 'Nope',
      });

      expect(isErrorResult(result)).toBe(true);
      if (isErrorResult(result)) {
        expect(result.error).toContain('Prerequisite not found');
        expect(result.error).toContain('non-existent-id');
      }
    });

    it('should return error when no fields are provided', () => {
      const created = registerPrerequisite(db, {
        command: 'pnpm dev',
        description: 'No-op update test',
      });
      expect(isErrorResult(created)).toBe(false);
      if (isErrorResult(created)) return;

      const result = updatePrerequisite(db, { id: created.id });
      expect(isErrorResult(result)).toBe(true);
      if (isErrorResult(result)) {
        expect(result.error).toContain('No fields to update');
      }
    });

    it('should update sort_order', () => {
      const created = registerPrerequisite(db, {
        command: 'pnpm dev',
        description: 'Sort order test',
        sort_order: 0,
      });
      expect(isErrorResult(created)).toBe(false);
      if (isErrorResult(created)) return;

      const updated = updatePrerequisite(db, { id: created.id, sort_order: 10 });
      expect(isErrorResult(updated)).toBe(false);
      if (!isErrorResult(updated)) {
        expect(updated.sort_order).toBe(10);
      }
    });
  });

  // ============================================================================
  // delete_prerequisite
  // ============================================================================

  describe('delete_prerequisite', () => {
    it('should delete an existing prerequisite', () => {
      const created = registerPrerequisite(db, {
        command: 'pnpm dev',
        description: 'Delete me',
      });
      expect(isErrorResult(created)).toBe(false);
      if (isErrorResult(created)) return;

      const result = deletePrerequisite(db, created.id);
      expect(isErrorResult(result)).toBe(false);
      if (!isErrorResult(result)) {
        expect(result.deleted).toBe(true);
        expect(result.message).toContain('Delete me');
      }

      // Confirm it's gone
      const row = db.prepare('SELECT id FROM demo_prerequisites WHERE id = ?').get(created.id);
      expect(row).toBeUndefined();
    });

    it('should return error for non-existent prerequisite', () => {
      const result = deletePrerequisite(db, 'non-existent-id');
      expect(isErrorResult(result)).toBe(true);
      if (isErrorResult(result)) {
        expect(result.error).toContain('Prerequisite not found');
        expect(result.error).toContain('non-existent-id');
      }
    });
  });

  // ============================================================================
  // list_prerequisites
  // ============================================================================

  describe('list_prerequisites', () => {
    it('should list all enabled prerequisites by default', () => {
      registerPrerequisite(db, {
        command: 'pnpm dev',
        description: 'Dev server',
        scope: 'global',
        sort_order: 1,
      });
      registerPrerequisite(db, {
        command: 'pnpm seed',
        description: 'Seed data',
        scope: 'global',
        sort_order: 2,
      });

      const result = listPrerequisites(db, {});
      expect(result.total).toBe(2);
      expect(result.prerequisites).toHaveLength(2);
    });

    it('should filter by scope=global', () => {
      registerPrerequisite(db, {
        command: 'pnpm dev',
        description: 'Global prerequisite',
        scope: 'global',
      });
      registerPrerequisite(db, {
        command: 'pnpm seed:persona',
        description: 'Persona prerequisite',
        scope: 'persona',
        persona_id: guiPersona.id,
      });

      const result = listPrerequisites(db, { scope: 'global' });
      expect(result.total).toBe(1);
      expect(result.prerequisites[0].scope).toBe('global');
      expect(result.prerequisites[0].description).toBe('Global prerequisite');
    });

    it('should filter by scope=persona', () => {
      registerPrerequisite(db, {
        command: 'pnpm dev',
        description: 'Global prerequisite',
        scope: 'global',
      });
      registerPrerequisite(db, {
        command: 'pnpm seed:persona',
        description: 'Persona prerequisite',
        scope: 'persona',
        persona_id: guiPersona.id,
      });

      const result = listPrerequisites(db, { scope: 'persona' });
      expect(result.total).toBe(1);
      expect(result.prerequisites[0].scope).toBe('persona');
      expect(result.prerequisites[0].persona_name).toBe('test-gui-user');
    });

    it('should filter by scope=scenario', () => {
      registerPrerequisite(db, {
        command: 'pnpm dev',
        description: 'Global prerequisite',
        scope: 'global',
      });
      registerPrerequisite(db, {
        command: 'pnpm seed:scenario',
        description: 'Scenario prerequisite',
        scope: 'scenario',
        scenario_id: scenario.id,
      });

      const result = listPrerequisites(db, { scope: 'scenario' });
      expect(result.total).toBe(1);
      expect(result.prerequisites[0].scope).toBe('scenario');
      expect(result.prerequisites[0].scenario_title).toBe('Onboarding Flow');
    });

    it('should filter by persona_id', () => {
      const secondPersona = createPersona(db, {
        name: 'second-gui-user',
        description: 'Another GUI persona',
        consumption_mode: 'gui',
      });

      registerPrerequisite(db, {
        command: 'pnpm seed:first',
        description: 'For first persona',
        scope: 'persona',
        persona_id: guiPersona.id,
      });
      registerPrerequisite(db, {
        command: 'pnpm seed:second',
        description: 'For second persona',
        scope: 'persona',
        persona_id: secondPersona.id,
      });

      const result = listPrerequisites(db, { persona_id: guiPersona.id });
      expect(result.total).toBe(1);
      expect(result.prerequisites[0].persona_id).toBe(guiPersona.id);
      expect(result.prerequisites[0].persona_name).toBe('test-gui-user');
    });

    it('should filter by scenario_id', () => {
      const secondScenario = createScenario(db, {
        persona_id: guiPersona.id,
        title: 'Billing Flow',
        description: 'Walk through billing',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/billing.demo.ts',
      });

      registerPrerequisite(db, {
        command: 'pnpm seed:onboarding',
        description: 'For onboarding scenario',
        scope: 'scenario',
        scenario_id: scenario.id,
      });
      registerPrerequisite(db, {
        command: 'pnpm seed:billing',
        description: 'For billing scenario',
        scope: 'scenario',
        scenario_id: secondScenario.id,
      });

      const result = listPrerequisites(db, { scenario_id: scenario.id });
      expect(result.total).toBe(1);
      expect(result.prerequisites[0].scenario_id).toBe(scenario.id);
      expect(result.prerequisites[0].scenario_title).toBe('Onboarding Flow');
    });

    it('should exclude disabled prerequisites when enabled_only is true (default)', () => {
      const created = registerPrerequisite(db, {
        command: 'pnpm dev',
        description: 'Will be disabled',
      });
      expect(isErrorResult(created)).toBe(false);
      if (!isErrorResult(created)) {
        updatePrerequisite(db, { id: created.id, enabled: false });
      }

      registerPrerequisite(db, {
        command: 'pnpm seed',
        description: 'Enabled prerequisite',
      });

      const result = listPrerequisites(db, { enabled_only: true });
      expect(result.total).toBe(1);
      expect(result.prerequisites[0].description).toBe('Enabled prerequisite');
    });

    it('should include disabled prerequisites when enabled_only is false', () => {
      const created = registerPrerequisite(db, {
        command: 'pnpm dev',
        description: 'Will be disabled',
      });
      expect(isErrorResult(created)).toBe(false);
      if (!isErrorResult(created)) {
        updatePrerequisite(db, { id: created.id, enabled: false });
      }

      registerPrerequisite(db, {
        command: 'pnpm seed',
        description: 'Enabled prerequisite',
      });

      const result = listPrerequisites(db, { enabled_only: false });
      expect(result.total).toBe(2);
    });

    it('should order by scope priority: global first, then persona, then scenario', () => {
      registerPrerequisite(db, {
        command: 'pnpm seed:scenario',
        description: 'Scenario-scoped',
        scope: 'scenario',
        scenario_id: scenario.id,
        sort_order: 0,
      });
      registerPrerequisite(db, {
        command: 'pnpm seed:persona',
        description: 'Persona-scoped',
        scope: 'persona',
        persona_id: guiPersona.id,
        sort_order: 0,
      });
      registerPrerequisite(db, {
        command: 'pnpm dev',
        description: 'Global',
        scope: 'global',
        sort_order: 0,
      });

      const result = listPrerequisites(db, { enabled_only: false });
      expect(result.total).toBe(3);
      expect(result.prerequisites[0].scope).toBe('global');
      expect(result.prerequisites[1].scope).toBe('persona');
      expect(result.prerequisites[2].scope).toBe('scenario');
    });

    it('should respect sort_order within the same scope', () => {
      registerPrerequisite(db, {
        command: 'pnpm step:b',
        description: 'Step B',
        scope: 'global',
        sort_order: 2,
      });
      registerPrerequisite(db, {
        command: 'pnpm step:a',
        description: 'Step A',
        scope: 'global',
        sort_order: 1,
      });
      registerPrerequisite(db, {
        command: 'pnpm step:c',
        description: 'Step C',
        scope: 'global',
        sort_order: 3,
      });

      const result = listPrerequisites(db, { scope: 'global' });
      expect(result.total).toBe(3);
      expect(result.prerequisites[0].description).toBe('Step A');
      expect(result.prerequisites[1].description).toBe('Step B');
      expect(result.prerequisites[2].description).toBe('Step C');
    });

    it('should enrich persona_name and scenario_title in list results', () => {
      registerPrerequisite(db, {
        command: 'pnpm seed:persona',
        description: 'Persona-scoped enrichment test',
        scope: 'persona',
        persona_id: guiPersona.id,
      });
      registerPrerequisite(db, {
        command: 'pnpm seed:scenario',
        description: 'Scenario-scoped enrichment test',
        scope: 'scenario',
        scenario_id: scenario.id,
      });

      const result = listPrerequisites(db, { enabled_only: false });
      const personaPrereq = result.prerequisites.find(p => p.scope === 'persona');
      const scenarioPrereq = result.prerequisites.find(p => p.scope === 'scenario');

      expect(personaPrereq?.persona_name).toBe('test-gui-user');
      expect(scenarioPrereq?.scenario_title).toBe('Onboarding Flow');
    });
  });

  // ============================================================================
  // CASCADE behavior
  // ============================================================================

  describe('CASCADE on persona delete', () => {
    it('should delete persona-scoped prerequisites when persona is deleted', () => {
      const prereq = registerPrerequisite(db, {
        command: 'pnpm seed:persona',
        description: 'Persona-scoped cascade test',
        scope: 'persona',
        persona_id: guiPersona.id,
      });
      expect(isErrorResult(prereq)).toBe(false);
      if (isErrorResult(prereq)) return;

      // Verify it exists
      const before = db.prepare('SELECT id FROM demo_prerequisites WHERE id = ?').get(prereq.id);
      expect(before).toBeDefined();

      // Delete the persona
      db.prepare('DELETE FROM personas WHERE id = ?').run(guiPersona.id);

      // Prerequisite should be cascade-deleted
      const after = db.prepare('SELECT id FROM demo_prerequisites WHERE id = ?').get(prereq.id);
      expect(after).toBeUndefined();
    });

    it('should not delete global prerequisites when persona is deleted', () => {
      const globalPrereq = registerPrerequisite(db, {
        command: 'pnpm dev',
        description: 'Global prerequisite not affected by persona delete',
        scope: 'global',
      });
      expect(isErrorResult(globalPrereq)).toBe(false);
      if (isErrorResult(globalPrereq)) return;

      // Delete the persona
      db.prepare('DELETE FROM personas WHERE id = ?').run(guiPersona.id);

      // Global prerequisite should still exist
      const after = db.prepare('SELECT id FROM demo_prerequisites WHERE id = ?').get(globalPrereq.id);
      expect(after).toBeDefined();
    });
  });

  describe('CASCADE on scenario delete', () => {
    it('should delete scenario-scoped prerequisites when scenario is deleted', () => {
      const prereq = registerPrerequisite(db, {
        command: 'pnpm seed:scenario',
        description: 'Scenario-scoped cascade test',
        scope: 'scenario',
        scenario_id: scenario.id,
      });
      expect(isErrorResult(prereq)).toBe(false);
      if (isErrorResult(prereq)) return;

      // Verify it exists
      const before = db.prepare('SELECT id FROM demo_prerequisites WHERE id = ?').get(prereq.id);
      expect(before).toBeDefined();

      // Delete the scenario
      db.prepare('DELETE FROM demo_scenarios WHERE id = ?').run(scenario.id);

      // Prerequisite should be cascade-deleted
      const after = db.prepare('SELECT id FROM demo_prerequisites WHERE id = ?').get(prereq.id);
      expect(after).toBeUndefined();
    });

    it('should not delete global prerequisites when scenario is deleted', () => {
      const globalPrereq = registerPrerequisite(db, {
        command: 'pnpm dev',
        description: 'Global prerequisite not affected by scenario delete',
        scope: 'global',
      });
      expect(isErrorResult(globalPrereq)).toBe(false);
      if (isErrorResult(globalPrereq)) return;

      // Delete the scenario
      db.prepare('DELETE FROM demo_scenarios WHERE id = ?').run(scenario.id);

      // Global prerequisite should still exist
      const after = db.prepare('SELECT id FROM demo_prerequisites WHERE id = ?').get(globalPrereq.id);
      expect(after).toBeDefined();
    });

    it('should cascade-delete scenario prerequisites when parent persona is deleted', () => {
      const prereq = registerPrerequisite(db, {
        command: 'pnpm seed:onboarding',
        description: 'Scenario cascade via persona delete',
        scope: 'scenario',
        scenario_id: scenario.id,
      });
      expect(isErrorResult(prereq)).toBe(false);
      if (isErrorResult(prereq)) return;

      // Deleting the persona cascades to its scenarios, which cascade to prerequisites
      db.prepare('DELETE FROM personas WHERE id = ?').run(guiPersona.id);

      // Scenario prerequisite should be gone (cascaded through demo_scenarios)
      const after = db.prepare('SELECT id FROM demo_prerequisites WHERE id = ?').get(prereq.id);
      expect(after).toBeUndefined();
    });
  });
});
