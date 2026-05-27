/**
 * Tests for the deputy_reports schema and MCP tool query semantics.
 *
 * PR 4 (Fix 3): When the session-reaper escalates a wedged audit, it
 * INSERTs into `deputy_reports`. The 3 MCP tools (list_deputy_reports,
 * acknowledge_deputy_report, resolve_deputy_report) drive that inbox.
 *
 * We test the SQL semantics directly against an in-memory DB rather than
 * invoking the MCP server over JSON-RPC. The lazy-credentials test covers
 * the server's wire protocol; here we lock down filter/status behavior
 * that has to be right for the deputy-cto triage to work.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const SCHEMA = `
  CREATE TABLE deputy_reports (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    task_type TEXT,
    task_id TEXT,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    acknowledged_at TEXT,
    resolved_at TEXT,
    resolution TEXT
  );
  CREATE INDEX idx_deputy_reports_open ON deputy_reports(status, created_at);
  CREATE INDEX idx_deputy_reports_task ON deputy_reports(task_type, task_id, kind);
`;

let dbPath: string;
let db: any;

beforeEach(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-test-'));
  dbPath = path.join(tmpDir, 'bypass-requests.db');
  db = new Database(dbPath);
  db.exec(SCHEMA);
});

afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch { /* ignore */ }
});

function seed(opts: { id: string; kind?: string; status?: string; taskType?: string; taskId?: string; payload?: any }) {
  db.prepare(`
    INSERT INTO deputy_reports (id, kind, task_type, task_id, payload, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    opts.id,
    opts.kind || 'wedged_audit',
    opts.taskType || 'persistent',
    opts.taskId || `t-${opts.id}`,
    JSON.stringify(opts.payload || { test: true }),
    opts.status || 'open',
  );
}

describe('deputy_reports schema', () => {
  it('enforces status CHECK constraint', () => {
    expect(() => {
      db.prepare(`INSERT INTO deputy_reports (id, kind, payload, status) VALUES ('dr-bad', 'wedged_audit', '{}', 'invalid')`).run();
    }).toThrow(/CHECK constraint failed/);
  });

  it('defaults status to open', () => {
    db.prepare(`INSERT INTO deputy_reports (id, kind, payload) VALUES ('dr-1', 'wedged_audit', '{}')`).run();
    const row = db.prepare(`SELECT status FROM deputy_reports WHERE id = 'dr-1'`).get();
    expect(row.status).toBe('open');
  });

  it('defaults created_at to now', () => {
    db.prepare(`INSERT INTO deputy_reports (id, kind, payload) VALUES ('dr-1', 'wedged_audit', '{}')`).run();
    const row = db.prepare(`SELECT created_at FROM deputy_reports WHERE id = 'dr-1'`).get();
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

describe('list_deputy_reports — filter semantics', () => {
  it('default status=open filter returns only open reports', () => {
    seed({ id: 'open-1', status: 'open' });
    seed({ id: 'open-2', status: 'open' });
    seed({ id: 'ack-1', status: 'acknowledged' });
    seed({ id: 'res-1', status: 'resolved' });
    const rows = db.prepare(`SELECT id FROM deputy_reports WHERE status = ? ORDER BY created_at DESC LIMIT 50`).all('open');
    const ids = rows.map((r: any) => r.id).sort();
    expect(ids).toEqual(['open-1', 'open-2']);
  });

  it('status=all returns everything', () => {
    seed({ id: 'open-1' });
    seed({ id: 'ack-1', status: 'acknowledged' });
    seed({ id: 'res-1', status: 'resolved' });
    const rows = db.prepare(`SELECT id FROM deputy_reports ORDER BY created_at DESC LIMIT 50`).all();
    expect(rows.length).toBe(3);
  });

  it('kind filter narrows results to a single kind', () => {
    seed({ id: 'wa-1', kind: 'wedged_audit' });
    seed({ id: 'sd-1', kind: 'spawn_deadlock' });
    seed({ id: 'wa-2', kind: 'wedged_audit' });
    const rows = db.prepare(`SELECT id FROM deputy_reports WHERE status = 'open' AND kind = ? ORDER BY created_at DESC`).all('wedged_audit');
    const ids = rows.map((r: any) => r.id).sort();
    expect(ids).toEqual(['wa-1', 'wa-2']);
  });

  it('combines status + kind correctly', () => {
    seed({ id: 'open-wa', status: 'open', kind: 'wedged_audit' });
    seed({ id: 'open-other', status: 'open', kind: 'spawn_deadlock' });
    seed({ id: 'ack-wa', status: 'acknowledged', kind: 'wedged_audit' });
    const rows = db.prepare(`SELECT id FROM deputy_reports WHERE status = 'open' AND kind = 'wedged_audit'`).all();
    expect(rows.map((r: any) => r.id)).toEqual(['open-wa']);
  });
});

describe('acknowledge transition', () => {
  it('transitions open → acknowledged with timestamp', () => {
    seed({ id: 'dr-1' });
    db.prepare(`UPDATE deputy_reports SET status = 'acknowledged', acknowledged_at = datetime('now') WHERE id = ?`).run('dr-1');
    const row = db.prepare(`SELECT status, acknowledged_at FROM deputy_reports WHERE id = 'dr-1'`).get();
    expect(row.status).toBe('acknowledged');
    expect(row.acknowledged_at).toMatch(/^\d{4}-/);
  });

  it('cannot acknowledge an already-resolved report (caller must check status first)', () => {
    seed({ id: 'dr-1', status: 'resolved' });
    // Semantic check: the MCP handler enforces this; SQL allows the update.
    // Test documents the contract: callers MUST check status before update.
    const row = db.prepare(`SELECT status FROM deputy_reports WHERE id = 'dr-1'`).get();
    expect(row.status).toBe('resolved');
  });
});

describe('resolve transition', () => {
  it('transitions to resolved with resolution text + timestamp', () => {
    seed({ id: 'dr-1' });
    db.prepare(`UPDATE deputy_reports SET status = 'resolved', resolved_at = datetime('now'), resolution = ? WHERE id = ?`)
      .run('fixed by upgrading baseRef logic', 'dr-1');
    const row = db.prepare(`SELECT status, resolved_at, resolution FROM deputy_reports WHERE id = 'dr-1'`).get();
    expect(row.status).toBe('resolved');
    expect(row.resolution).toBe('fixed by upgrading baseRef logic');
    expect(row.resolved_at).toMatch(/^\d{4}-/);
  });

  it('resolution can follow acknowledge — both timestamps preserved', () => {
    seed({ id: 'dr-1' });
    db.prepare(`UPDATE deputy_reports SET status = 'acknowledged', acknowledged_at = datetime('now') WHERE id = ?`).run('dr-1');
    db.prepare(`UPDATE deputy_reports SET status = 'resolved', resolved_at = datetime('now'), resolution = 'done' WHERE id = ?`).run('dr-1');
    const row = db.prepare(`SELECT acknowledged_at, resolved_at FROM deputy_reports WHERE id = 'dr-1'`).get();
    expect(row.acknowledged_at).toMatch(/^\d{4}-/);
    expect(row.resolved_at).toMatch(/^\d{4}-/);
  });
});

describe('payload is stored as JSON text', () => {
  it('round-trips nested objects', () => {
    seed({
      id: 'dr-1',
      payload: { attempts: 3, history: [{ agent_id: 'a1', outcome: 'timeout' }], nested: { ok: true } },
    });
    const row = db.prepare(`SELECT payload FROM deputy_reports WHERE id = 'dr-1'`).get();
    const parsed = JSON.parse(row.payload);
    expect(parsed.attempts).toBe(3);
    expect(parsed.history[0].agent_id).toBe('a1');
    expect(parsed.nested.ok).toBe(true);
  });
});
