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
  created_at: string;
  created_timestamp: number;
  updated_at: string;
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
  created_at: string;
  updated_at: string;
  persona_name?: string;
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
  const created_timestamp = Math.floor(now.getTime() / 1000);
  const modes = Array.isArray(args.consumption_mode) ? args.consumption_mode : [args.consumption_mode];

  db.prepare(`
    INSERT INTO personas (id, name, description, consumption_modes, behavior_traits, endpoints, created_at, created_timestamp, updated_at)
    VALUES (?, ?, ?, ?, '[]', '[]', ?, ?, ?)
  `).run(id, args.name, args.description, JSON.stringify(modes), created_at, created_timestamp, created_at);

  return { id, name: args.name, consumption_modes: modes };
}

function scenarioToResult(row: ScenarioRow & { persona_name?: string }): ScenarioResult {
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
    created_at: row.created_at,
    updated_at: row.updated_at,
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
}): ScenarioResult | ErrorResult {
  // Validate persona exists and includes 'gui' in consumption_modes
  const persona = db.prepare('SELECT id, name, consumption_modes FROM personas WHERE id = ?')
    .get(args.persona_id) as { id: string; name: string; consumption_modes: string } | undefined;

  if (!persona) {
    return { error: `Persona not found: ${args.persona_id}` };
  }
  const personaModes = JSON.parse(persona.consumption_modes) as string[];
  if (!personaModes.includes('gui')) {
    return {
      error: `Demo scenarios require a GUI persona. Persona "${persona.name}" has consumption_modes ${JSON.stringify(personaModes)}. Only personas that include "gui" in consumption_modes can have Playwright demo scenarios.`,
    };
  }
  if (!args.test_file.endsWith('.demo.ts')) {
    return { error: `test_file must end with ".demo.ts" — got "${args.test_file}"` };
  }

  const id = randomUUID();
  const now = new Date();
  const created_at = now.toISOString();
  const created_timestamp = Math.floor(now.getTime() / 1000);

  try {
    db.prepare(`
      INSERT INTO demo_scenarios (id, persona_id, title, description, category, playwright_project, test_file, sort_order, enabled, created_at, created_timestamp, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(
      id, args.persona_id, args.title, args.description,
      args.category ?? null, args.playwright_project, args.test_file,
      args.sort_order ?? 0, created_at, created_timestamp, created_at,
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
}): ScenarioResult | ErrorResult {
  const existing = db.prepare('SELECT id FROM demo_scenarios WHERE id = ?').get(args.id);
  if (!existing) {
    return { error: `Scenario not found: ${args.id}` };
  }

  if (args.test_file && !args.test_file.endsWith('.demo.ts')) {
    return { error: `test_file must end with ".demo.ts" — got "${args.test_file}"` };
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

    it('should reject non-GUI persona', () => {
      const result = createScenario(db, {
        persona_id: apiPersona.id,
        title: 'API Flow',
        description: 'Test API flow',
        playwright_project: 'vendor-owner',
        test_file: 'e2e/demo/api-flow.demo.ts',
      });

      expect(isErrorResult(result)).toBe(true);
      if (isErrorResult(result)) {
        expect(result.error).toContain('Demo scenarios require a GUI persona');
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

    it('should reject all non-gui consumption modes', () => {
      const modes = ['cli', 'api', 'sdk', 'adk'];
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
});
