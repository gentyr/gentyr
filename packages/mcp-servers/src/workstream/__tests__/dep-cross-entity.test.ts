/**
 * Unit tests for cross-entity dependency foundation (workstream server).
 *
 * Covers:
 *  - Schema migration is idempotent (re-running migration on an already-migrated
 *    DB is a no-op).
 *  - AddDependencyArgsSchema accepts both the legacy {blocker_task_id, blocked_task_id, reasoning}
 *    shape and the new entity-aware {blocker, blocked, reasoning} shape.
 *  - ListDependenciesForEntityArgsSchema parses correctly with defaults.
 *
 * NOTE: end-to-end tests that exercise pause-if-running across the three source
 * DBs (todo.db / persistent-tasks.db / plans.db) live with the gate extensions
 * in follow-up PRs. This file covers the schema/parse layer only.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import {
  AddDependencyArgsSchema,
  ListDependenciesForEntityArgsSchema,
  ENTITY_TYPES,
} from '../types.js';

// ---------------------------------------------------------------------------
// Helper: create an isolated workstream.db at a temp path and seed it with
// the legacy pre-migration schema so we can exercise the migration path.
// ---------------------------------------------------------------------------

const LEGACY_SCHEMA = `
CREATE TABLE IF NOT EXISTS queue_dependencies (
  id TEXT PRIMARY KEY,
  blocked_queue_id TEXT,
  blocked_task_id TEXT NOT NULL,
  blocker_queue_id TEXT,
  blocker_task_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  created_at TEXT NOT NULL,
  satisfied_at TEXT,
  UNIQUE(blocked_task_id, blocker_task_id)
);
CREATE INDEX IF NOT EXISTS idx_dep_blocked ON queue_dependencies(blocked_task_id, status);
CREATE INDEX IF NOT EXISTS idx_dep_blocker ON queue_dependencies(blocker_task_id, status);
`;

function createLegacyDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(LEGACY_SCHEMA);
  return db;
}

// Reimplement migrateCrossEntityDeps inline here so we can test it without
// going through the module's full ensureDb() bootstrap (which reads
// CLAUDE_PROJECT_DIR at module load time). Keep this in sync with
// packages/mcp-servers/src/workstream/server.ts.
function migrateCrossEntityDeps(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(queue_dependencies)').all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));

  if (!colNames.has('blocked_entity_type')) {
    db.exec(
      `ALTER TABLE queue_dependencies ADD COLUMN blocked_entity_type TEXT NOT NULL DEFAULT 'todo' CHECK (blocked_entity_type IN ('todo','persistent','plan_task'))`
    );
  }
  if (!colNames.has('blocker_entity_type')) {
    db.exec(
      `ALTER TABLE queue_dependencies ADD COLUMN blocker_entity_type TEXT NOT NULL DEFAULT 'todo' CHECK (blocker_entity_type IN ('todo','persistent','plan_task'))`
    );
  }
  if (!colNames.has('pause_action')) {
    db.exec(`ALTER TABLE queue_dependencies ADD COLUMN pause_action TEXT`);
  }

  const tableDef = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='queue_dependencies'")
    .get() as { sql: string } | undefined;

  if (tableDef) {
    const hasNewUnique =
      /UNIQUE\s*\(\s*blocked_entity_type\s*,\s*blocked_task_id\s*,\s*blocker_entity_type\s*,\s*blocker_task_id\s*\)/i.test(
        tableDef.sql
      );
    const hasOldUnique = /UNIQUE\s*\(\s*blocked_task_id\s*,\s*blocker_task_id\s*\)/i.test(
      tableDef.sql
    );

    if (hasOldUnique && !hasNewUnique) {
      const swap = db.transaction(() => {
        db.exec(`
          CREATE TABLE queue_dependencies_new (
            id TEXT PRIMARY KEY,
            blocked_queue_id TEXT,
            blocked_task_id TEXT NOT NULL,
            blocked_entity_type TEXT NOT NULL DEFAULT 'todo' CHECK (blocked_entity_type IN ('todo','persistent','plan_task')),
            blocker_queue_id TEXT,
            blocker_task_id TEXT NOT NULL,
            blocker_entity_type TEXT NOT NULL DEFAULT 'todo' CHECK (blocker_entity_type IN ('todo','persistent','plan_task')),
            status TEXT NOT NULL DEFAULT 'active',
            created_by TEXT NOT NULL,
            reasoning TEXT NOT NULL,
            pause_action TEXT,
            created_at TEXT NOT NULL,
            satisfied_at TEXT,
            UNIQUE(blocked_entity_type, blocked_task_id, blocker_entity_type, blocker_task_id)
          )
        `);
        db.exec(`
          INSERT INTO queue_dependencies_new
            (id, blocked_queue_id, blocked_task_id, blocked_entity_type, blocker_queue_id, blocker_task_id, blocker_entity_type, status, created_by, reasoning, pause_action, created_at, satisfied_at)
          SELECT
            id, blocked_queue_id, blocked_task_id, blocked_entity_type, blocker_queue_id, blocker_task_id, blocker_entity_type, status, created_by, reasoning, pause_action, created_at, satisfied_at
          FROM queue_dependencies
        `);
        db.exec('DROP TABLE queue_dependencies');
        db.exec('ALTER TABLE queue_dependencies_new RENAME TO queue_dependencies');
      });
      swap();
    }
  }

  db.exec('DROP INDEX IF EXISTS idx_dep_blocked');
  db.exec('DROP INDEX IF EXISTS idx_dep_blocker');
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_dep_blocked_entity ON queue_dependencies(blocked_entity_type, blocked_task_id, status)'
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_dep_blocker_entity ON queue_dependencies(blocker_entity_type, blocker_task_id, status)'
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cross-entity dep migration', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `workstream-${randomUUID()}.db`);
  });

  afterEach(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = dbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it('adds the three new columns when starting from the legacy schema', () => {
    const db = createLegacyDb(dbPath);
    migrateCrossEntityDeps(db);

    const cols = db.prepare('PRAGMA table_info(queue_dependencies)').all() as Array<{
      name: string;
    }>;
    const names = new Set(cols.map((c) => c.name));

    expect(names.has('blocked_entity_type')).toBe(true);
    expect(names.has('blocker_entity_type')).toBe(true);
    expect(names.has('pause_action')).toBe(true);
    db.close();
  });

  it('broadens the UNIQUE constraint via shadow-table swap', () => {
    const db = createLegacyDb(dbPath);
    migrateCrossEntityDeps(db);

    const tableDef = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='queue_dependencies'")
      .get() as { sql: string };

    // New constraint must be present.
    expect(
      /UNIQUE\s*\(\s*blocked_entity_type\s*,\s*blocked_task_id\s*,\s*blocker_entity_type\s*,\s*blocker_task_id\s*\)/i.test(
        tableDef.sql
      )
    ).toBe(true);
    // Old narrower constraint must NOT remain on the new table.
    expect(/UNIQUE\s*\(\s*blocked_task_id\s*,\s*blocker_task_id\s*\)/i.test(tableDef.sql)).toBe(
      false
    );
    db.close();
  });

  it('preserves existing rows through the shadow-table swap with default entity_type=todo', () => {
    const db = createLegacyDb(dbPath);
    db.prepare(
      'INSERT INTO queue_dependencies (id, blocked_task_id, blocker_task_id, status, created_by, reasoning, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('dep-1', 'task-a', 'task-b', 'active', 'test', 'pre-migration row', '2026-05-19T00:00:00Z');

    migrateCrossEntityDeps(db);

    const row = db.prepare('SELECT * FROM queue_dependencies WHERE id = ?').get('dep-1') as Record<
      string,
      unknown
    >;
    expect(row['blocked_task_id']).toBe('task-a');
    expect(row['blocker_task_id']).toBe('task-b');
    expect(row['blocked_entity_type']).toBe('todo');
    expect(row['blocker_entity_type']).toBe('todo');
    expect(row['pause_action']).toBeNull();
    db.close();
  });

  it('is idempotent — running migration twice is safe', () => {
    const db = createLegacyDb(dbPath);
    migrateCrossEntityDeps(db);
    expect(() => migrateCrossEntityDeps(db)).not.toThrow();

    // Schema should still look correct after the second run.
    const cols = db.prepare('PRAGMA table_info(queue_dependencies)').all() as Array<{
      name: string;
    }>;
    const names = new Set(cols.map((c) => c.name));
    expect(names.has('blocked_entity_type')).toBe(true);
    expect(names.has('blocker_entity_type')).toBe(true);
    expect(names.has('pause_action')).toBe(true);
    db.close();
  });

  it('allows cross-entity inserts after migration (broader UNIQUE)', () => {
    const db = createLegacyDb(dbPath);
    migrateCrossEntityDeps(db);

    const insert = db.prepare(
      'INSERT INTO queue_dependencies (id, blocked_task_id, blocked_entity_type, blocker_task_id, blocker_entity_type, status, created_by, reasoning, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );

    // Two deps that share task IDs but differ on entity_type — allowed under
    // the new UNIQUE; would have been rejected under the old constraint.
    expect(() =>
      insert.run('d1', 'x', 'todo', 'y', 'todo', 'active', 'test', 'r1', 'ts1')
    ).not.toThrow();
    expect(() =>
      insert.run('d2', 'x', 'persistent', 'y', 'persistent', 'active', 'test', 'r2', 'ts2')
    ).not.toThrow();

    // Exact duplicate must still fail.
    expect(() =>
      insert.run('d3', 'x', 'todo', 'y', 'todo', 'active', 'test', 'r3', 'ts3')
    ).toThrow();
    db.close();
  });
});

describe('AddDependencyArgsSchema (union)', () => {
  it('accepts the legacy {blocker_task_id, blocked_task_id, reasoning} shape', () => {
    const parsed = AddDependencyArgsSchema.parse({
      blocked_task_id: 'task-a',
      blocker_task_id: 'task-b',
      reasoning: 'legacy shape backward-compat',
    });
    // Either branch of the union may match; verify at least the legacy fields round-trip.
    expect(parsed).toMatchObject({
      blocked_task_id: 'task-a',
      blocker_task_id: 'task-b',
    });
  });

  it('accepts the new entity-aware {blocker, blocked, reasoning} shape', () => {
    const parsed = AddDependencyArgsSchema.parse({
      blocker: { entity_type: 'persistent', entity_id: 'pt-1' },
      blocked: { entity_type: 'todo', entity_id: 'task-1' },
      reasoning: 'persistent blocks todo — cross-entity case',
    });
    expect(parsed).toMatchObject({
      blocker: { entity_type: 'persistent', entity_id: 'pt-1' },
      blocked: { entity_type: 'todo', entity_id: 'task-1' },
    });
  });

  it('rejects invalid entity_type values', () => {
    expect(() =>
      AddDependencyArgsSchema.parse({
        blocker: { entity_type: 'session', entity_id: 'x' },
        blocked: { entity_type: 'todo', entity_id: 'y' },
        reasoning: 'session is not a valid entity_type',
      })
    ).toThrow();
  });

  it('rejects reasoning shorter than 10 characters', () => {
    expect(() =>
      AddDependencyArgsSchema.parse({
        blocked_task_id: 'a',
        blocker_task_id: 'b',
        reasoning: 'short',
      })
    ).toThrow();
  });
});

describe('ListDependenciesForEntityArgsSchema', () => {
  it('defaults direction to "both" and status to "active"', () => {
    const parsed = ListDependenciesForEntityArgsSchema.parse({
      entity_type: 'plan_task',
      entity_id: 'pt-task-1',
    });
    expect(parsed.direction).toBe('both');
    expect(parsed.status).toBe('active');
  });

  it('accepts every valid entity_type', () => {
    for (const t of ENTITY_TYPES) {
      const parsed = ListDependenciesForEntityArgsSchema.parse({
        entity_type: t,
        entity_id: 'x',
      });
      expect(parsed.entity_type).toBe(t);
    }
  });

  it('rejects invalid direction values', () => {
    expect(() =>
      ListDependenciesForEntityArgsSchema.parse({
        entity_type: 'todo',
        entity_id: 'x',
        direction: 'sideways',
      })
    ).toThrow();
  });
});
