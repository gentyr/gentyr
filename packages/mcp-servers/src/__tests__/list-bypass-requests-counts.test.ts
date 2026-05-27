/**
 * list_bypass_requests filter + summary_counts tests
 *
 * PR 1 (Fix 4 + Fix 5) — the tool gains:
 *   - synthesized filter ('real' | 'synthesized' | 'all', default 'real')
 *   - summary_counts response field with { real, synthesized, overdue, total }
 *
 * These tests run the SQL the tool generates against an in-memory SQLite DB
 * pre-loaded with a mix of real and synthesized rows, and verify the filter
 * + count behavior matches what the handler does. We do not invoke the MCP
 * tool over JSON-RPC here — that path is covered by the server-side smoke
 * test in lazy-credentials.test.ts; here we lock down the SQL semantics.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const BYPASS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS bypass_requests (
    id TEXT PRIMARY KEY,
    task_type TEXT NOT NULL,
    task_id TEXT NOT NULL,
    task_title TEXT NOT NULL,
    agent_id TEXT,
    session_queue_id TEXT,
    category TEXT NOT NULL DEFAULT 'general',
    summary TEXT NOT NULL,
    details TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    resolution_context TEXT,
    resolved_at TEXT,
    resolved_by TEXT DEFAULT 'cto',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    auto_resume_at TEXT,
    pause_duration_minutes INTEGER,
    deputy_escalated INTEGER DEFAULT 0,
    synthesized INTEGER NOT NULL DEFAULT 0,
    synthesizer TEXT,
    synthesis_account TEXT,
    auto_resolvable INTEGER NOT NULL DEFAULT 0,
    synthesis_count INTEGER NOT NULL DEFAULT 1,
    CHECK (task_type IN ('persistent', 'todo')),
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
    CHECK (category IN ('destructive_operation', 'scope_change', 'ambiguous_requirement', 'resource_access', 'general'))
  );
`;

let dbPath: string;
let db: any;

beforeEach(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lbq-test-'));
  dbPath = path.join(tmpDir, 'bypass-requests.db');
  db = new Database(dbPath);
  db.exec(BYPASS_SCHEMA_SQL);
});

afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch { /* ignore */ }
});

interface SeedOpts {
  id: string;
  synthesized?: boolean;
  auto_resolvable?: boolean;
  status?: string;
  deputy_escalated?: boolean;
}

function seed(opts: SeedOpts) {
  db.prepare(`
    INSERT INTO bypass_requests (id, task_type, task_id, task_title, category, summary, status, synthesized, auto_resolvable, deputy_escalated)
    VALUES (?, 'persistent', ?, ?, 'general', ?, ?, ?, ?, ?)
  `).run(
    opts.id, `t-${opts.id}`, `Task ${opts.id}`, `summary ${opts.id}`,
    opts.status || 'pending',
    opts.synthesized ? 1 : 0,
    opts.auto_resolvable ? 1 : 0,
    opts.deputy_escalated ? 1 : 0,
  );
}

/**
 * Mirror of the conditional WHERE-clause logic from listBypassRequests().
 * Kept here as the canonical reference — if the handler SQL changes shape,
 * update this helper in lockstep.
 */
function buildWhereForFilter(status: string, synthesizedMode: string): { sql: string; params: any[] } {
  const conditions: string[] = [];
  const params: any[] = [];
  if (status !== 'all') {
    conditions.push('status = ?');
    params.push(status);
  }
  if (synthesizedMode === 'real') {
    conditions.push('COALESCE(synthesized, 0) = 0');
  } else if (synthesizedMode === 'synthesized') {
    conditions.push('COALESCE(synthesized, 0) = 1');
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return { sql: where, params };
}

describe('list_bypass_requests filter semantics', () => {
  it('default filter (synthesized=real) returns only agent-authored rows', () => {
    seed({ id: 'real-1', synthesized: false });
    seed({ id: 'real-2', synthesized: false });
    seed({ id: 'syn-1', synthesized: true, auto_resolvable: true });
    seed({ id: 'syn-2', synthesized: true, auto_resolvable: true });
    const { sql, params } = buildWhereForFilter('pending', 'real');
    const rows = db.prepare(`SELECT id FROM bypass_requests ${sql}`).all(...params);
    const ids = rows.map((r: any) => r.id).sort();
    expect(ids).toEqual(['real-1', 'real-2']);
  });

  it('synthesized=synthesized filter returns only framework-generated rows', () => {
    seed({ id: 'real-1', synthesized: false });
    seed({ id: 'syn-1', synthesized: true, auto_resolvable: true });
    seed({ id: 'syn-2', synthesized: true, auto_resolvable: true });
    const { sql, params } = buildWhereForFilter('pending', 'synthesized');
    const rows = db.prepare(`SELECT id FROM bypass_requests ${sql}`).all(...params);
    const ids = rows.map((r: any) => r.id).sort();
    expect(ids).toEqual(['syn-1', 'syn-2']);
  });

  it('synthesized=all filter returns everything', () => {
    seed({ id: 'real-1', synthesized: false });
    seed({ id: 'syn-1', synthesized: true, auto_resolvable: true });
    const { sql, params } = buildWhereForFilter('pending', 'all');
    const rows = db.prepare(`SELECT id FROM bypass_requests ${sql}`).all(...params);
    expect(rows.length).toBe(2);
  });

  it('combines status filter with synthesized filter correctly', () => {
    seed({ id: 'real-pending', synthesized: false, status: 'pending' });
    seed({ id: 'real-approved', synthesized: false, status: 'approved' });
    seed({ id: 'syn-pending', synthesized: true, auto_resolvable: true, status: 'pending' });
    const { sql, params } = buildWhereForFilter('pending', 'real');
    const rows = db.prepare(`SELECT id FROM bypass_requests ${sql}`).all(...params);
    expect(rows.map((r: any) => r.id)).toEqual(['real-pending']);
  });
});

describe('list_bypass_requests summary_counts', () => {
  it('counts real/synthesized/overdue independently of the active filter', () => {
    seed({ id: 'real-1', synthesized: false });
    seed({ id: 'real-2', synthesized: false });
    seed({ id: 'syn-1', synthesized: true, auto_resolvable: true });
    seed({ id: 'syn-2', synthesized: true, auto_resolvable: true });
    seed({ id: 'syn-3', synthesized: true, auto_resolvable: true });
    seed({ id: 'overdue-1', synthesized: false, deputy_escalated: true });

    // These three queries are exactly what the handler runs to populate
    // summary_counts. They are independent of the user's active filter.
    const real = (db.prepare(
      "SELECT COUNT(*) as cnt FROM bypass_requests WHERE status = 'pending' AND auto_resume_at IS NULL AND COALESCE(synthesized, 0) = 0"
    ).get() as { cnt: number }).cnt;
    const synthesized = (db.prepare(
      "SELECT COUNT(*) as cnt FROM bypass_requests WHERE status = 'pending' AND auto_resume_at IS NULL AND COALESCE(synthesized, 0) = 1"
    ).get() as { cnt: number }).cnt;
    const overdue = (db.prepare(
      "SELECT COUNT(*) as cnt FROM bypass_requests WHERE status = 'pending' AND COALESCE(deputy_escalated, 0) = 1"
    ).get() as { cnt: number }).cnt;

    expect(real).toBe(3); // real-1, real-2, overdue-1
    expect(synthesized).toBe(3);
    expect(overdue).toBe(1);
    expect(real + synthesized).toBe(6);
  });

  it('returns zero counts when no pending rows exist', () => {
    seed({ id: 'approved-1', status: 'approved' });
    const real = (db.prepare(
      "SELECT COUNT(*) as cnt FROM bypass_requests WHERE status = 'pending' AND COALESCE(synthesized, 0) = 0"
    ).get() as { cnt: number }).cnt;
    expect(real).toBe(0);
  });

  it('COALESCE handles rows from pre-migration schemas correctly', () => {
    // Simulate an old INSERT that doesn't set the synthesized column.
    // SQLite assigns the column DEFAULT (0) automatically. The COALESCE
    // in the count query treats NULL as 0 too, for extra safety on schemas
    // where DEFAULT 0 was not set at create time.
    db.prepare(`
      INSERT INTO bypass_requests (id, task_type, task_id, task_title, category, summary, status)
      VALUES ('legacy-1', 'persistent', 't-legacy', 'Legacy', 'general', 'agent asks', 'pending')
    `).run();
    const row = db.prepare('SELECT synthesized FROM bypass_requests WHERE id = ?').get('legacy-1') as any;
    expect(row.synthesized).toBe(0);
    const real = (db.prepare(
      "SELECT COUNT(*) as cnt FROM bypass_requests WHERE status = 'pending' AND COALESCE(synthesized, 0) = 0"
    ).get() as { cnt: number }).cnt;
    expect(real).toBe(1);
  });
});
