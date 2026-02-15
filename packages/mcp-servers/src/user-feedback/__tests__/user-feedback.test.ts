/**
 * Unit tests for User Feedback MCP Server
 *
 * Tests persona CRUD, feature CRUD, persona-feature mapping,
 * change analysis, feedback run management, and G001/G003 compliance.
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
  CONSUMPTION_MODES,
  FEATURE_PRIORITIES,
  FEEDBACK_RUN_STATUSES,
  FEEDBACK_SESSION_STATUSES,
} from '../../__testUtils__/schemas.js';
import {
  createPersonaFixture,
  createFeatureFixture,
  insertPersonaFixture,
  insertFeatureFixture,
  insertPersonaFeatureMapping,
} from '../../__testUtils__/fixtures.js';

// ============================================================================
// Database Row Types
// ============================================================================

interface PersonaRow {
  id: string;
  name: string;
  description: string;
  consumption_mode: string;
  behavior_traits: string;
  endpoints: string;
  credentials_ref: string | null;
  enabled: number;
  created_at: string;
  created_timestamp: number;
  updated_at: string;
}

interface FeatureRow {
  id: string;
  name: string;
  description: string | null;
  file_patterns: string;
  url_patterns: string;
  category: string | null;
  created_at: string;
  created_timestamp: number;
}

interface MappingRow {
  persona_id: string;
  feature_id: string;
  priority: string;
  test_scenarios: string;
}

interface RunRow {
  id: string;
  trigger_type: string;
  trigger_ref: string | null;
  changed_features: string;
  personas_triggered: string;
  status: string;
  max_concurrent: number;
  started_at: string;
  completed_at: string | null;
  summary: string | null;
}

interface SessionRow {
  id: string;
  run_id: string;
  persona_id: string;
  agent_id: string | null;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  findings_count: number;
  report_ids: string;
}

interface CountResult {
  count: number;
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
  consumption_mode: string;
  behavior_traits?: string[];
  endpoints?: string[];
  credentials_ref?: string;
}) {
  const id = randomUUID();
  const now = new Date();
  const created_at = now.toISOString();
  const created_timestamp = Math.floor(now.getTime() / 1000);

  try {
    db.prepare(`
      INSERT INTO personas (id, name, description, consumption_mode, behavior_traits, endpoints, credentials_ref, created_at, created_timestamp, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, args.name, args.description, args.consumption_mode,
      JSON.stringify(args.behavior_traits ?? []),
      JSON.stringify(args.endpoints ?? []),
      args.credentials_ref ?? null,
      created_at, created_timestamp, created_at,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('UNIQUE constraint')) {
      return { error: `Persona with name "${args.name}" already exists` };
    }
    return { error: `Failed: ${message}` };
  }

  return { id, name: args.name };
}

function registerFeature(db: Database.Database, args: {
  name: string;
  description?: string;
  file_patterns: string[];
  url_patterns?: string[];
  category?: string;
}) {
  const id = randomUUID();
  const now = new Date();

  try {
    db.prepare(`
      INSERT INTO features (id, name, description, file_patterns, url_patterns, category, created_at, created_timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, args.name, args.description ?? null,
      JSON.stringify(args.file_patterns),
      JSON.stringify(args.url_patterns ?? []),
      args.category ?? null,
      now.toISOString(),
      Math.floor(now.getTime() / 1000),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('UNIQUE constraint')) {
      return { error: `Feature with name "${args.name}" already exists` };
    }
    return { error: `Failed: ${message}` };
  }

  return { id, name: args.name };
}

function mapPersonaToFeature(db: Database.Database, args: {
  persona_id: string;
  feature_id: string;
  priority?: string;
  test_scenarios?: string[];
}) {
  db.prepare(`
    INSERT OR REPLACE INTO persona_features (persona_id, feature_id, priority, test_scenarios)
    VALUES (?, ?, ?, ?)
  `).run(
    args.persona_id, args.feature_id,
    args.priority ?? 'normal',
    JSON.stringify(args.test_scenarios ?? []),
  );
}

/**
 * Simple glob matching for file patterns (mirrors server implementation).
 */
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

function getPersonasForChanges(db: Database.Database, changedFiles: string[]) {
  const allFeatures = db.prepare('SELECT * FROM features').all() as FeatureRow[];
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

  if (affectedFeatureIds.size === 0) {
    return { personas: [], matched_features: [] };
  }

  const featureIdList = Array.from(affectedFeatureIds);
  const placeholders = featureIdList.map(() => '?').join(',');

  const mappings = db.prepare(`
    SELECT pf.persona_id, pf.feature_id, pf.priority, pf.test_scenarios,
           p.name as p_name, f.name as f_name
    FROM persona_features pf
    JOIN personas p ON p.id = pf.persona_id
    JOIN features f ON f.id = pf.feature_id
    WHERE pf.feature_id IN (${placeholders})
      AND p.enabled = 1
  `).all(...featureIdList) as (MappingRow & { p_name: string; f_name: string })[];

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

// ============================================================================
// Tests
// ============================================================================

describe('User Feedback Server', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb(USER_FEEDBACK_SCHEMA);
  });

  afterEach(() => {
    db.close();
  });

  // ============================================================================
  // Persona CRUD Tests
  // ============================================================================

  describe('Persona CRUD', () => {
    it('should create a persona with required fields', () => {
      const result = createPersona(db, {
        name: 'power-user',
        description: 'An experienced user who uses keyboard shortcuts',
        consumption_mode: 'gui',
      });

      expect(result.id).toBeDefined();
      expect(result.name).toBe('power-user');

      const row = db.prepare('SELECT * FROM personas WHERE id = ?').get(result.id) as PersonaRow;
      expect(row.name).toBe('power-user');
      expect(row.consumption_mode).toBe('gui');
      expect(row.enabled).toBe(1);
      expect(JSON.parse(row.behavior_traits)).toEqual([]);
    });

    it('should create a persona with all fields', () => {
      const result = createPersona(db, {
        name: 'api-consumer',
        description: 'A developer using the REST API',
        consumption_mode: 'api',
        behavior_traits: ['impatient', 'reads docs carefully'],
        endpoints: ['/api/v1/users', '/api/v1/tasks'],
        credentials_ref: 'op://vault/api-key',
      });

      const row = db.prepare('SELECT * FROM personas WHERE id = ?').get(result.id) as PersonaRow;
      expect(row.consumption_mode).toBe('api');
      expect(JSON.parse(row.behavior_traits)).toEqual(['impatient', 'reads docs carefully']);
      expect(JSON.parse(row.endpoints)).toEqual(['/api/v1/users', '/api/v1/tasks']);
      expect(row.credentials_ref).toBe('op://vault/api-key');
    });

    it('should enforce unique name constraint', () => {
      createPersona(db, { name: 'test-user', description: 'Test', consumption_mode: 'gui' });
      const result = createPersona(db, { name: 'test-user', description: 'Duplicate', consumption_mode: 'cli' });

      expect(isErrorResult(result)).toBe(true);
      if (isErrorResult(result)) {
        expect(result.error).toContain('already exists');
      }
    });

    it('should enforce valid consumption_mode constraint (G003)', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO personas (id, name, description, consumption_mode, created_at, created_timestamp, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(randomUUID(), 'test', 'desc', 'invalid', new Date().toISOString(), Math.floor(Date.now() / 1000), new Date().toISOString());
      }).toThrow();
    });

    it('should accept all valid consumption modes', () => {
      for (const mode of CONSUMPTION_MODES) {
        const result = createPersona(db, {
          name: `user-${mode}`,
          description: `${mode} user`,
          consumption_mode: mode,
        });
        expect(result.id).toBeDefined();
      }
    });

    it('should update persona fields', () => {
      const persona = createPersona(db, { name: 'old-name', description: 'Old', consumption_mode: 'gui' });

      db.prepare('UPDATE personas SET name = ?, description = ?, updated_at = ? WHERE id = ?')
        .run('new-name', 'Updated description', new Date().toISOString(), persona.id);

      const row = db.prepare('SELECT * FROM personas WHERE id = ?').get(persona.id) as PersonaRow;
      expect(row.name).toBe('new-name');
      expect(row.description).toBe('Updated description');
    });

    it('should delete a persona', () => {
      const persona = createPersona(db, { name: 'to-delete', description: 'Delete me', consumption_mode: 'gui' });

      db.prepare('DELETE FROM personas WHERE id = ?').run(persona.id);

      const row = db.prepare('SELECT * FROM personas WHERE id = ?').get(persona.id);
      expect(row).toBeUndefined();
    });

    it('should cascade delete persona_features when persona deleted', () => {
      const persona = createPersona(db, { name: 'cascade-test', description: 'Test', consumption_mode: 'gui' });
      const feature = registerFeature(db, { name: 'feature-1', file_patterns: ['src/**'] });
      mapPersonaToFeature(db, { persona_id: persona.id!, feature_id: feature.id! });

      // Verify mapping exists
      const beforeCount = (db.prepare('SELECT COUNT(*) as count FROM persona_features WHERE persona_id = ?')
        .get(persona.id) as CountResult).count;
      expect(beforeCount).toBe(1);

      // Delete persona
      db.prepare('DELETE FROM personas WHERE id = ?').run(persona.id);

      // Mapping should be gone
      const afterCount = (db.prepare('SELECT COUNT(*) as count FROM persona_features WHERE persona_id = ?')
        .get(persona.id) as CountResult).count;
      expect(afterCount).toBe(0);
    });

    it('should list personas with filters', () => {
      createPersona(db, { name: 'gui-1', description: 'GUI user', consumption_mode: 'gui' });
      createPersona(db, { name: 'cli-1', description: 'CLI user', consumption_mode: 'cli' });
      createPersona(db, { name: 'gui-2', description: 'Another GUI', consumption_mode: 'gui' });

      // All
      const all = db.prepare('SELECT * FROM personas').all() as PersonaRow[];
      expect(all).toHaveLength(3);

      // Filter by mode
      const guiOnly = db.prepare('SELECT * FROM personas WHERE consumption_mode = ?').all('gui') as PersonaRow[];
      expect(guiOnly).toHaveLength(2);

      // Filter by enabled
      db.prepare('UPDATE personas SET enabled = 0 WHERE name = ?').run('gui-2');
      const enabledOnly = db.prepare('SELECT * FROM personas WHERE enabled = 1').all() as PersonaRow[];
      expect(enabledOnly).toHaveLength(2);
    });
  });

  // ============================================================================
  // Feature CRUD Tests
  // ============================================================================

  describe('Feature CRUD', () => {
    it('should register a feature with required fields', () => {
      const result = registerFeature(db, {
        name: 'user-authentication',
        file_patterns: ['src/auth/**', 'src/middleware/auth*'],
      });

      expect(result.id).toBeDefined();

      const row = db.prepare('SELECT * FROM features WHERE id = ?').get(result.id) as FeatureRow;
      expect(row.name).toBe('user-authentication');
      expect(JSON.parse(row.file_patterns)).toEqual(['src/auth/**', 'src/middleware/auth*']);
    });

    it('should register a feature with all fields', () => {
      const result = registerFeature(db, {
        name: 'billing',
        description: 'Billing and payment features',
        file_patterns: ['src/billing/**'],
        url_patterns: ['/billing', '/api/v1/billing/*'],
        category: 'payments',
      });

      const row = db.prepare('SELECT * FROM features WHERE id = ?').get(result.id) as FeatureRow;
      expect(row.description).toBe('Billing and payment features');
      expect(JSON.parse(row.url_patterns)).toEqual(['/billing', '/api/v1/billing/*']);
      expect(row.category).toBe('payments');
    });

    it('should enforce unique name constraint', () => {
      registerFeature(db, { name: 'auth', file_patterns: ['src/auth/**'] });
      const result = registerFeature(db, { name: 'auth', file_patterns: ['src/auth2/**'] });

      expect(isErrorResult(result)).toBe(true);
    });

    it('should delete a feature', () => {
      const feature = registerFeature(db, { name: 'temp', file_patterns: ['tmp/**'] });
      db.prepare('DELETE FROM features WHERE id = ?').run(feature.id);

      const row = db.prepare('SELECT * FROM features WHERE id = ?').get(feature.id);
      expect(row).toBeUndefined();
    });

    it('should cascade delete persona_features when feature deleted', () => {
      const persona = createPersona(db, { name: 'p1', description: 'P1', consumption_mode: 'gui' });
      const feature = registerFeature(db, { name: 'f1', file_patterns: ['src/**'] });
      mapPersonaToFeature(db, { persona_id: persona.id!, feature_id: feature.id! });

      db.prepare('DELETE FROM features WHERE id = ?').run(feature.id);

      const count = (db.prepare('SELECT COUNT(*) as count FROM persona_features WHERE feature_id = ?')
        .get(feature.id) as CountResult).count;
      expect(count).toBe(0);
    });

    it('should list features with category filter', () => {
      registerFeature(db, { name: 'auth-login', file_patterns: ['src/auth/**'], category: 'auth' });
      registerFeature(db, { name: 'auth-signup', file_patterns: ['src/signup/**'], category: 'auth' });
      registerFeature(db, { name: 'billing', file_patterns: ['src/billing/**'], category: 'payments' });

      const authFeatures = db.prepare('SELECT * FROM features WHERE category = ?').all('auth') as FeatureRow[];
      expect(authFeatures).toHaveLength(2);
    });
  });

  // ============================================================================
  // Persona-Feature Mapping Tests
  // ============================================================================

  describe('Persona-Feature Mapping', () => {
    it('should create a mapping', () => {
      const persona = createPersona(db, { name: 'p1', description: 'P1', consumption_mode: 'gui' });
      const feature = registerFeature(db, { name: 'f1', file_patterns: ['src/**'] });

      mapPersonaToFeature(db, {
        persona_id: persona.id!,
        feature_id: feature.id!,
        priority: 'high',
        test_scenarios: ['Test login', 'Test logout'],
      });

      const mapping = db.prepare('SELECT * FROM persona_features WHERE persona_id = ? AND feature_id = ?')
        .get(persona.id, feature.id) as MappingRow;
      expect(mapping.priority).toBe('high');
      expect(JSON.parse(mapping.test_scenarios)).toEqual(['Test login', 'Test logout']);
    });

    it('should enforce valid priority constraint', () => {
      const persona = createPersona(db, { name: 'p1', description: 'P1', consumption_mode: 'gui' });
      const feature = registerFeature(db, { name: 'f1', file_patterns: ['src/**'] });

      expect(() => {
        db.prepare('INSERT INTO persona_features (persona_id, feature_id, priority) VALUES (?, ?, ?)')
          .run(persona.id, feature.id, 'invalid');
      }).toThrow();
    });

    it('should accept all valid priorities', () => {
      const persona = createPersona(db, { name: 'p1', description: 'P1', consumption_mode: 'gui' });

      for (const priority of FEATURE_PRIORITIES) {
        const feature = registerFeature(db, { name: `f-${priority}`, file_patterns: ['src/**'] });
        mapPersonaToFeature(db, {
          persona_id: persona.id!,
          feature_id: feature.id!,
          priority,
        });
      }

      const count = (db.prepare('SELECT COUNT(*) as count FROM persona_features WHERE persona_id = ?')
        .get(persona.id) as CountResult).count;
      expect(count).toBe(FEATURE_PRIORITIES.length);
    });

    it('should update mapping on INSERT OR REPLACE', () => {
      const persona = createPersona(db, { name: 'p1', description: 'P1', consumption_mode: 'gui' });
      const feature = registerFeature(db, { name: 'f1', file_patterns: ['src/**'] });

      mapPersonaToFeature(db, { persona_id: persona.id!, feature_id: feature.id!, priority: 'normal' });
      mapPersonaToFeature(db, { persona_id: persona.id!, feature_id: feature.id!, priority: 'critical' });

      const mapping = db.prepare('SELECT * FROM persona_features WHERE persona_id = ? AND feature_id = ?')
        .get(persona.id, feature.id) as MappingRow;
      expect(mapping.priority).toBe('critical');
    });

    it('should remove a mapping', () => {
      const persona = createPersona(db, { name: 'p1', description: 'P1', consumption_mode: 'gui' });
      const feature = registerFeature(db, { name: 'f1', file_patterns: ['src/**'] });
      mapPersonaToFeature(db, { persona_id: persona.id!, feature_id: feature.id! });

      db.prepare('DELETE FROM persona_features WHERE persona_id = ? AND feature_id = ?')
        .run(persona.id, feature.id);

      const count = (db.prepare('SELECT COUNT(*) as count FROM persona_features WHERE persona_id = ?')
        .get(persona.id) as CountResult).count;
      expect(count).toBe(0);
    });
  });

  // ============================================================================
  // Change Analysis Tests
  // ============================================================================

  describe('Change Analysis (get_personas_for_changes)', () => {
    it('should match files to features using glob patterns', () => {
      const persona = createPersona(db, { name: 'p1', description: 'P1', consumption_mode: 'gui' });
      const feature = registerFeature(db, { name: 'auth', file_patterns: ['src/auth/**'] });
      mapPersonaToFeature(db, { persona_id: persona.id!, feature_id: feature.id! });

      const result = getPersonasForChanges(db, ['src/auth/login.ts', 'src/auth/session.ts']);

      expect(result.personas).toHaveLength(1);
      expect(result.personas[0].persona_name).toBe('p1');
      expect(result.matched_features).toHaveLength(1);
    });

    it('should return empty when no files match', () => {
      const persona = createPersona(db, { name: 'p1', description: 'P1', consumption_mode: 'gui' });
      const feature = registerFeature(db, { name: 'auth', file_patterns: ['src/auth/**'] });
      mapPersonaToFeature(db, { persona_id: persona.id!, feature_id: feature.id! });

      const result = getPersonasForChanges(db, ['src/billing/invoice.ts']);

      expect(result.personas).toHaveLength(0);
      expect(result.matched_features).toHaveLength(0);
    });

    it('should match multiple features from one file change', () => {
      const persona = createPersona(db, { name: 'p1', description: 'P1', consumption_mode: 'gui' });
      const feature1 = registerFeature(db, { name: 'auth', file_patterns: ['src/auth/**'] });
      const feature2 = registerFeature(db, { name: 'middleware', file_patterns: ['src/auth/middleware*'] });
      mapPersonaToFeature(db, { persona_id: persona.id!, feature_id: feature1.id! });
      mapPersonaToFeature(db, { persona_id: persona.id!, feature_id: feature2.id! });

      const result = getPersonasForChanges(db, ['src/auth/middleware.ts']);

      expect(result.personas).toHaveLength(1);
      expect(result.personas[0].matched_features).toHaveLength(2);
    });

    it('should select multiple personas across modes', () => {
      const guiPersona = createPersona(db, { name: 'gui-user', description: 'GUI', consumption_mode: 'gui' });
      const cliPersona = createPersona(db, { name: 'cli-user', description: 'CLI', consumption_mode: 'cli' });
      const feature = registerFeature(db, { name: 'shared', file_patterns: ['src/core/**'] });
      mapPersonaToFeature(db, { persona_id: guiPersona.id!, feature_id: feature.id! });
      mapPersonaToFeature(db, { persona_id: cliPersona.id!, feature_id: feature.id! });

      const result = getPersonasForChanges(db, ['src/core/utils.ts']);

      expect(result.personas).toHaveLength(2);
    });

    it('should exclude disabled personas', () => {
      const persona = createPersona(db, { name: 'disabled', description: 'Off', consumption_mode: 'gui' });
      const feature = registerFeature(db, { name: 'f1', file_patterns: ['src/**'] });
      mapPersonaToFeature(db, { persona_id: persona.id!, feature_id: feature.id! });

      db.prepare('UPDATE personas SET enabled = 0 WHERE id = ?').run(persona.id);

      const result = getPersonasForChanges(db, ['src/index.ts']);
      expect(result.personas).toHaveLength(0);
    });

    it('should handle ** glob for deep matching', () => {
      const persona = createPersona(db, { name: 'p1', description: 'P1', consumption_mode: 'gui' });
      const feature = registerFeature(db, { name: 'deep', file_patterns: ['src/**/*.ts'] });
      mapPersonaToFeature(db, { persona_id: persona.id!, feature_id: feature.id! });

      const result = getPersonasForChanges(db, [
        'src/auth/login/handler.ts',
        'src/utils.ts',
        'docs/readme.md', // Should not match
      ]);

      expect(result.personas).toHaveLength(1);
    });

    it('should handle * glob for single-level matching', () => {
      const persona = createPersona(db, { name: 'p1', description: 'P1', consumption_mode: 'gui' });
      const feature = registerFeature(db, { name: 'routes', file_patterns: ['src/routes/*.ts'] });
      mapPersonaToFeature(db, { persona_id: persona.id!, feature_id: feature.id! });

      // Should match
      const match = getPersonasForChanges(db, ['src/routes/api.ts']);
      expect(match.personas).toHaveLength(1);

      // Should NOT match (nested)
      const noMatch = getPersonasForChanges(db, ['src/routes/nested/api.ts']);
      expect(noMatch.personas).toHaveLength(0);
    });
  });

  // ============================================================================
  // Feedback Run Tests
  // ============================================================================

  describe('Feedback Run Management', () => {
    it('should create a feedback run with sessions', () => {
      const persona = createPersona(db, { name: 'p1', description: 'P1', consumption_mode: 'gui' });
      const feature = registerFeature(db, { name: 'f1', file_patterns: ['src/**'] });
      mapPersonaToFeature(db, { persona_id: persona.id!, feature_id: feature.id! });

      const runId = randomUUID();
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO feedback_runs (id, trigger_type, trigger_ref, changed_features, personas_triggered, status, max_concurrent, started_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(runId, 'manual', 'test-ref', JSON.stringify([feature.id]), JSON.stringify([persona.id]), 3, now);

      db.prepare(`
        INSERT INTO feedback_sessions (id, run_id, persona_id, status)
        VALUES (?, ?, ?, 'pending')
      `).run(randomUUID(), runId, persona.id);

      const run = db.prepare('SELECT * FROM feedback_runs WHERE id = ?').get(runId) as RunRow;
      expect(run.status).toBe('pending');
      expect(run.trigger_type).toBe('manual');

      const sessions = db.prepare('SELECT * FROM feedback_sessions WHERE run_id = ?').all(runId) as SessionRow[];
      expect(sessions).toHaveLength(1);
      expect(sessions[0].persona_id).toBe(persona.id);
    });

    it('should enforce valid run status', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO feedback_runs (id, trigger_type, changed_features, personas_triggered, status, max_concurrent, started_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(randomUUID(), 'manual', '[]', '[]', 'invalid', 3, new Date().toISOString());
      }).toThrow();
    });

    it('should accept all valid run statuses', () => {
      for (const status of FEEDBACK_RUN_STATUSES) {
        const id = randomUUID();
        db.prepare(`
          INSERT INTO feedback_runs (id, trigger_type, changed_features, personas_triggered, status, max_concurrent, started_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(id, 'manual', '[]', '[]', status, 3, new Date().toISOString());

        const row = db.prepare('SELECT status FROM feedback_runs WHERE id = ?').get(id) as RunRow;
        expect(row.status).toBe(status);
      }
    });

    it('should enforce valid session status', () => {
      const runId = randomUUID();
      db.prepare(`
        INSERT INTO feedback_runs (id, trigger_type, changed_features, personas_triggered, status, max_concurrent, started_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?)
      `).run(runId, 'manual', '[]', '[]', 3, new Date().toISOString());

      const persona = createPersona(db, { name: 'p1', description: 'P', consumption_mode: 'gui' });

      expect(() => {
        db.prepare(`
          INSERT INTO feedback_sessions (id, run_id, persona_id, status)
          VALUES (?, ?, ?, ?)
        `).run(randomUUID(), runId, persona.id, 'invalid');
      }).toThrow();
    });

    it('should accept all valid session statuses', () => {
      const runId = randomUUID();
      db.prepare(`
        INSERT INTO feedback_runs (id, trigger_type, changed_features, personas_triggered, status, max_concurrent, started_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?)
      `).run(runId, 'manual', '[]', '[]', 3, new Date().toISOString());

      const persona = createPersona(db, { name: 'p1', description: 'P', consumption_mode: 'gui' });

      for (const status of FEEDBACK_SESSION_STATUSES) {
        const id = randomUUID();
        db.prepare(`
          INSERT INTO feedback_sessions (id, run_id, persona_id, status)
          VALUES (?, ?, ?, ?)
        `).run(id, runId, persona.id, status);

        const row = db.prepare('SELECT status FROM feedback_sessions WHERE id = ?').get(id) as SessionRow;
        expect(row.status).toBe(status);
      }
    });

    it('should complete a feedback session', () => {
      const runId = randomUUID();
      const sessionId = randomUUID();
      const persona = createPersona(db, { name: 'p1', description: 'P', consumption_mode: 'gui' });

      db.prepare(`
        INSERT INTO feedback_runs (id, trigger_type, changed_features, personas_triggered, status, max_concurrent, started_at)
        VALUES (?, ?, ?, ?, 'in_progress', ?, ?)
      `).run(runId, 'manual', '[]', JSON.stringify([persona.id]), 3, new Date().toISOString());

      db.prepare(`
        INSERT INTO feedback_sessions (id, run_id, persona_id, status)
        VALUES (?, ?, ?, 'running')
      `).run(sessionId, runId, persona.id);

      // Complete the session
      const now = new Date().toISOString();
      const reportIds = ['report-1', 'report-2'];
      db.prepare(`
        UPDATE feedback_sessions SET status = 'completed', completed_at = ?, findings_count = ?, report_ids = ?
        WHERE id = ?
      `).run(now, 3, JSON.stringify(reportIds), sessionId);

      const session = db.prepare('SELECT * FROM feedback_sessions WHERE id = ?').get(sessionId) as SessionRow;
      expect(session.status).toBe('completed');
      expect(session.findings_count).toBe(3);
      expect(JSON.parse(session.report_ids)).toEqual(reportIds);
    });
  });

  // ============================================================================
  // Glob Matching Tests
  // ============================================================================

  describe('Glob Matching', () => {
    it('should match exact paths', () => {
      expect(globMatch('src/index.ts', 'src/index.ts')).toBe(true);
      expect(globMatch('src/index.ts', 'src/other.ts')).toBe(false);
    });

    it('should match * for single level', () => {
      expect(globMatch('src/*.ts', 'src/index.ts')).toBe(true);
      expect(globMatch('src/*.ts', 'src/utils.ts')).toBe(true);
      expect(globMatch('src/*.ts', 'src/nested/file.ts')).toBe(false);
    });

    it('should match ** for multiple levels', () => {
      expect(globMatch('src/**', 'src/index.ts')).toBe(true);
      expect(globMatch('src/**', 'src/deep/nested/file.ts')).toBe(true);
      expect(globMatch('src/**/*.ts', 'src/deep/nested/file.ts')).toBe(true);
    });

    it('should match ? for single character', () => {
      expect(globMatch('src/?.ts', 'src/a.ts')).toBe(true);
      expect(globMatch('src/?.ts', 'src/ab.ts')).toBe(false);
    });

    it('should handle special regex chars in paths', () => {
      expect(globMatch('src/file.test.ts', 'src/file.test.ts')).toBe(true);
      expect(globMatch('src/(utils)/index.ts', 'src/(utils)/index.ts')).toBe(true);
    });
  });

  // ============================================================================
  // Database Schema Tests
  // ============================================================================

  describe('Database Schema', () => {
    it('should have index on personas consumption_mode', () => {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_personas_mode'")
        .all();
      expect(indexes).toHaveLength(1);
    });

    it('should have index on features category', () => {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_features_category'")
        .all();
      expect(indexes).toHaveLength(1);
    });

    it('should have index on feedback_runs status', () => {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_runs_status'")
        .all();
      expect(indexes).toHaveLength(1);
    });

    it('should have index on feedback_sessions run_id', () => {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sessions_run'")
        .all();
      expect(indexes).toHaveLength(1);
    });

    it('should enforce foreign keys', () => {
      // Enable FK enforcement for this test
      db.pragma('foreign_keys = ON');

      expect(() => {
        db.prepare('INSERT INTO persona_features (persona_id, feature_id, priority) VALUES (?, ?, ?)')
          .run('non-existent', 'non-existent', 'normal');
      }).toThrow();
    });
  });
});
