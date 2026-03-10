/**
 * CTO Reports - G011 Idempotency Tests
 *
 * Tests for G011-compliant deduplication in the CTO Reports MCP server.
 * Validates:
 * - Agent+title dedup via idx_reports_agent_title_dedup partial UNIQUE index
 * - Idempotency key dedup via idx_reports_idempotency_key partial UNIQUE index
 * - UNIQUE constraint enforcement as race-condition safety net
 *
 * All tests operate at the DATABASE level — no MCP server is started.
 * We create an in-memory SQLite database with the production schema and
 * exercise the dedup logic directly.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

// ============================================================================
// Test Schema (mirrors production schema from cto-reports/server.ts)
// ============================================================================

const TEST_SCHEMA = `
CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    reporting_agent TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'other',
    priority TEXT NOT NULL DEFAULT 'normal',
    created_at TEXT NOT NULL,
    created_timestamp TEXT NOT NULL,
    read_at TEXT,
    acknowledged_at TEXT,
    idempotency_key TEXT,
    triage_status TEXT NOT NULL DEFAULT 'pending',
    triage_started_at TEXT,
    triage_completed_at TEXT,
    triage_session_id TEXT,
    triage_outcome TEXT,
    triaged_at TEXT,
    triage_action TEXT,
    CONSTRAINT valid_category CHECK (category IN ('architecture', 'security', 'performance', 'breaking-change', 'blocker', 'decision', 'user-feedback', 'other')),
    CONSTRAINT valid_priority CHECK (priority IN ('low', 'normal', 'high', 'critical')),
    CONSTRAINT valid_triage_status CHECK (triage_status IN ('pending', 'in_progress', 'self_handled', 'escalated', 'dismissed'))
);

CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_reports_acknowledged ON reports(acknowledged_at);
CREATE INDEX IF NOT EXISTS idx_reports_triage_status ON reports(triage_status);
CREATE INDEX IF NOT EXISTS idx_reports_triage_completed ON reports(triage_completed_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_agent_title_dedup
  ON reports(reporting_agent, title) WHERE triage_status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_idempotency_key
  ON reports(idempotency_key) WHERE idempotency_key IS NOT NULL AND triage_status = 'pending';
`;

// ============================================================================
// Helpers
// ============================================================================

interface ReportToCtoArgs {
  reporting_agent: string;
  title: string;
  summary: string;
  category?: string;
  priority?: string;
  idempotency_key?: string;
}

interface ReportToCtoResult {
  id: string;
  message: string;
}

interface DbReport {
  id: string;
  reporting_agent: string;
  title: string;
  summary: string;
  category: string;
  priority: string;
  created_at: string;
  created_timestamp: string;
  idempotency_key: string | null;
  triage_status: string;
}

function countReports(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) as count FROM reports').get() as { count: number }).count;
}

/**
 * Mirrors the G011-compliant reportToCto() logic from server.ts.
 * Uses try/catch UNIQUE fallback for both agent+title and idempotency_key constraints.
 */
function reportToCto(db: Database.Database, args: ReportToCtoArgs): ReportToCtoResult {
  const id = randomUUID();
  const now = new Date();
  const created_at = now.toISOString();
  const created_timestamp = now.toISOString();

  try {
    db.prepare(`
      INSERT INTO reports (id, reporting_agent, title, summary, category, priority, created_at, created_timestamp, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      args.reporting_agent,
      args.title,
      args.summary,
      args.category ?? 'other',
      args.priority ?? 'normal',
      created_at,
      created_timestamp,
      args.idempotency_key ?? null,
    );
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      (err as Error & { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
    ) {
      if (args.idempotency_key) {
        const fallback = db.prepare(
          `SELECT id, title FROM reports WHERE idempotency_key = ? AND triage_status = 'pending'`
        ).get(args.idempotency_key) as { id: string; title: string } | undefined;
        if (fallback) {
          return {
            id: fallback.id,
            message: `Report already exists (idempotency key match). ID: ${fallback.id}`,
          };
        }
      }
      const fallback = db.prepare(
        `SELECT id, title FROM reports WHERE reporting_agent = ? AND title = ? AND triage_status = 'pending'`
      ).get(args.reporting_agent, args.title) as { id: string; title: string } | undefined;
      if (fallback) {
        return {
          id: fallback.id,
          message: `Report already exists (same agent + title, pending). ID: ${fallback.id}`,
        };
      }
    }
    throw err;
  }

  return {
    id,
    message: `Report submitted to CTO. ID: ${id}`,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('CTO Reports - G011 Idempotency', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.exec(TEST_SCHEMA);
  });

  // --------------------------------------------------------------------------
  // Agent + Title Dedup (idx_reports_agent_title_dedup)
  // --------------------------------------------------------------------------

  describe('Agent + Title dedup', () => {
    it('should deduplicate reports from the same agent with the same title (pending)', () => {
      const args: ReportToCtoArgs = {
        reporting_agent: 'test-agent',
        title: 'Duplicate report test',
        summary: 'First summary',
      };

      const first = reportToCto(db, args);
      const second = reportToCto(db, { ...args, summary: 'Second summary' });

      expect(second.id).toBe(first.id);
      expect(second.message).toContain('already exists');
      expect(countReports(db)).toBe(1);
    });

    it('should allow same agent+title when the first report is not pending', () => {
      const args: ReportToCtoArgs = {
        reporting_agent: 'test-agent',
        title: 'Non-pending report test',
        summary: 'First summary',
      };

      const first = reportToCto(db, args);
      // Mark as self_handled
      db.prepare("UPDATE reports SET triage_status = 'self_handled' WHERE id = ?").run(first.id);

      const second = reportToCto(db, { ...args, summary: 'Second summary' });
      expect(second.id).not.toBe(first.id);
      expect(countReports(db)).toBe(2);
    });

    it('should allow different agents with the same title', () => {
      const first = reportToCto(db, { reporting_agent: 'agent-1', title: 'Same title', summary: 'Summary 1' });
      const second = reportToCto(db, { reporting_agent: 'agent-2', title: 'Same title', summary: 'Summary 2' });

      expect(second.id).not.toBe(first.id);
      expect(countReports(db)).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // Idempotency Key Dedup (idx_reports_idempotency_key)
  // --------------------------------------------------------------------------

  describe('Idempotency key dedup', () => {
    it('should deduplicate reports with the same idempotency key (pending)', () => {
      const key = 'unique-key-123';
      const first = reportToCto(db, { reporting_agent: 'agent-a', title: 'Report A', summary: 'Summary', idempotency_key: key });
      const second = reportToCto(db, { reporting_agent: 'agent-b', title: 'Report B', summary: 'Different', idempotency_key: key });

      expect(second.id).toBe(first.id);
      expect(second.message).toContain('already exists');
      expect(countReports(db)).toBe(1);
    });

    it('should allow same idempotency key when the first report is not pending', () => {
      const key = 'reused-key';
      const first = reportToCto(db, { reporting_agent: 'agent-a', title: 'Report A', summary: 'Summary', idempotency_key: key });
      db.prepare("UPDATE reports SET triage_status = 'dismissed' WHERE id = ?").run(first.id);

      const second = reportToCto(db, { reporting_agent: 'agent-a', title: 'Report A2', summary: 'Summary 2', idempotency_key: key });
      expect(second.id).not.toBe(first.id);
      expect(countReports(db)).toBe(2);
    });

    it('should allow NULL idempotency keys without conflict', () => {
      reportToCto(db, { reporting_agent: 'agent-1', title: 'Title 1', summary: 'Summary 1' });
      reportToCto(db, { reporting_agent: 'agent-2', title: 'Title 2', summary: 'Summary 2' });
      expect(countReports(db)).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // UNIQUE constraint enforcement (raw INSERT tests)
  // --------------------------------------------------------------------------

  describe('UNIQUE constraint enforcement', () => {
    it('should enforce uniqueness via idx_reports_agent_title_dedup partial index for pending reports', () => {
      const id1 = randomUUID();
      const id2 = randomUUID();
      const iso = new Date().toISOString();

      db.prepare(`
        INSERT INTO reports (id, reporting_agent, title, summary, category, priority, created_at, created_timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id1, 'agent-a', 'Unique title', 'Summary', 'other', 'normal', iso, iso);

      expect(() => {
        db.prepare(`
          INSERT INTO reports (id, reporting_agent, title, summary, category, priority, created_at, created_timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id2, 'agent-a', 'Unique title', 'Different summary', 'other', 'normal', iso, iso);
      }).toThrow(/UNIQUE constraint failed/);
    });

    it('should allow same agent+title when first report is not pending (index is partial)', () => {
      const id1 = randomUUID();
      const id2 = randomUUID();
      const iso = new Date().toISOString();

      db.prepare(`
        INSERT INTO reports (id, reporting_agent, title, summary, category, priority, created_at, created_timestamp, triage_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id1, 'agent-b', 'Repeated title', 'First report', 'other', 'normal', iso, iso, 'self_handled');

      expect(() => {
        db.prepare(`
          INSERT INTO reports (id, reporting_agent, title, summary, category, priority, created_at, created_timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id2, 'agent-b', 'Repeated title', 'Second report', 'other', 'normal', iso, iso);
      }).not.toThrow();

      expect(countReports(db)).toBe(2);
    });

    it('should enforce uniqueness via idx_reports_idempotency_key partial index for pending reports', () => {
      const id1 = randomUUID();
      const id2 = randomUUID();
      const iso = new Date().toISOString();
      const key = 'duplicate-key-test';

      db.prepare(`
        INSERT INTO reports (id, reporting_agent, title, summary, category, priority, created_at, created_timestamp, idempotency_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id1, 'agent-c', 'Title One', 'Summary One', 'other', 'normal', iso, iso, key);

      expect(() => {
        db.prepare(`
          INSERT INTO reports (id, reporting_agent, title, summary, category, priority, created_at, created_timestamp, idempotency_key)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id2, 'agent-c', 'Title Two', 'Summary Two', 'other', 'normal', iso, iso, key);
      }).toThrow(/UNIQUE constraint failed/);
    });

    it('should allow same idempotency_key when first report is not pending', () => {
      const id1 = randomUUID();
      const id2 = randomUUID();
      const iso = new Date().toISOString();
      const key = 'reused-key-after-triage';

      db.prepare(`
        INSERT INTO reports (id, reporting_agent, title, summary, category, priority, created_at, created_timestamp, idempotency_key, triage_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id1, 'agent-d', 'First title', 'First summary', 'other', 'normal', iso, iso, key, 'dismissed');

      expect(() => {
        db.prepare(`
          INSERT INTO reports (id, reporting_agent, title, summary, category, priority, created_at, created_timestamp, idempotency_key)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id2, 'agent-d', 'Second title', 'Second summary', 'other', 'normal', iso, iso, key);
      }).not.toThrow();

      expect(countReports(db)).toBe(2);
    });

    it('should allow NULL idempotency_key for multiple reports with the same agent+title when not pending', () => {
      const iso = new Date().toISOString();

      db.prepare(`
        INSERT INTO reports (id, reporting_agent, title, summary, category, priority, created_at, created_timestamp, triage_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), 'agent-e', 'Recurring issue', 'First occurrence', 'other', 'normal', iso, iso, 'self_handled');

      expect(() => {
        db.prepare(`
          INSERT INTO reports (id, reporting_agent, title, summary, category, priority, created_at, created_timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(randomUUID(), 'agent-e', 'Recurring issue', 'Second occurrence', 'other', 'normal', iso, iso);
      }).not.toThrow();

      expect(countReports(db)).toBe(2);
    });
  });
});
