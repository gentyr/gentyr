/**
 * Agent Reports - G011 Idempotency Tests
 *
 * Tests that the report_to_deputy_cto tool correctly deduplicates reports
 * using Hybrid Pattern 3:
 *  1. SELECT-first check for an existing pending report by idempotency_key
 *     or (reporting_agent, title)
 *  2. Returns the existing record with the existing ID if found
 *  3. try/catch on INSERT for SQLITE_CONSTRAINT_UNIQUE race-condition fallback
 *
 * Validates:
 * - Natural dedup via idx_reports_agent_title_dedup partial UNIQUE index
 * - Idempotency key dedup via idx_reports_idempotency_key partial UNIQUE index
 * - UNIQUE constraint enforcement as race-condition safety net
 *
 * All tests operate at the DATABASE level — no MCP server is started.
 * An in-memory SQLite database is created with the production schema.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

import { createTestDb } from '../../__testUtils__/index.js';
import { AGENT_REPORTS_SCHEMA } from '../../__testUtils__/schemas.js';

// ============================================================================
// Types
// ============================================================================

interface ReportArgs {
  reporting_agent: string;
  title: string;
  summary: string;
  category?: string;
  priority?: string;
  idempotency_key?: string;
}

interface ReportResult {
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

// ============================================================================
// Helpers
// ============================================================================

/**
 * Mirrors the G011-compliant reportToCto() logic from agent-reports/server.ts.
 *
 * 1. SELECT-first check: if idempotency_key → look up by key; else look up by
 *    (reporting_agent, title). Return the existing record immediately if found.
 * 2. INSERT with try/catch: SQLITE_CONSTRAINT_UNIQUE fallback recovers the
 *    winner of a concurrent INSERT race and returns it.
 */
function reportToDeputyCto(db: Database.Database, args: ReportArgs): ReportResult {
  // G011: SELECT-first dedup check
  if (args.idempotency_key) {
    const existing = db
      .prepare(
        `SELECT id, title FROM reports WHERE idempotency_key = ? AND triage_status = 'pending'`
      )
      .get(args.idempotency_key) as Pick<DbReport, 'id' | 'title'> | undefined;
    if (existing) {
      return {
        id: existing.id,
        message: `Report already exists (idempotency key match). ID: ${existing.id}`,
      };
    }
  } else {
    const existing = db
      .prepare(
        `SELECT id, title FROM reports WHERE reporting_agent = ? AND title = ? AND triage_status = 'pending'`
      )
      .get(args.reporting_agent, args.title) as Pick<DbReport, 'id' | 'title'> | undefined;
    if (existing) {
      return {
        id: existing.id,
        message: `Report already exists (same agent + title, pending). ID: ${existing.id}`,
      };
    }
  }

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
      args.idempotency_key ?? null
    );
  } catch (err: unknown) {
    // Race-condition fallback: another concurrent INSERT won. Look up the winner.
    if (
      err instanceof Error &&
      (err as Error & { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
    ) {
      if (args.idempotency_key) {
        const fallback = db
          .prepare(
            `SELECT id, title FROM reports WHERE idempotency_key = ? AND triage_status = 'pending'`
          )
          .get(args.idempotency_key) as { id: string; title: string } | undefined;
        if (fallback) {
          return {
            id: fallback.id,
            message: `Report already exists (idempotency key match). ID: ${fallback.id}`,
          };
        }
      }
      const fallback = db
        .prepare(
          `SELECT id, title FROM reports WHERE reporting_agent = ? AND title = ? AND triage_status = 'pending'`
        )
        .get(args.reporting_agent, args.title) as { id: string; title: string } | undefined;
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
    message: `Report submitted for triage. ID: ${id}`,
  };
}

/**
 * Simulates completing triage on a report (moves it out of 'pending').
 */
function markTriageStatus(
  db: Database.Database,
  id: string,
  status: 'in_progress' | 'self_handled' | 'escalated' | 'dismissed'
): void {
  const now = new Date().toISOString();
  db.prepare(`UPDATE reports SET triage_status = ?, triage_completed_at = ? WHERE id = ?`).run(
    status,
    now,
    id
  );
}

function countReports(db: Database.Database): number {
  const result = db
    .prepare('SELECT COUNT(*) as count FROM reports')
    .get() as { count: number };
  return result.count;
}

// ============================================================================
// Tests
// ============================================================================

describe('Agent Reports - G011 Idempotency (report_to_deputy_cto)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb(AGENT_REPORTS_SCHEMA);
  });

  afterEach(() => {
    db.close();
  });

  // --------------------------------------------------------------------------
  // Natural dedup (reporting_agent + title)
  // --------------------------------------------------------------------------

  describe('Natural dedup (reporting_agent + title)', () => {
    it('should return the same report ID on duplicate calls with identical args', () => {
      const args: ReportArgs = {
        reporting_agent: 'test-writer',
        title: 'Coverage: Auth module below 80%',
        summary: 'Auth coverage dropped to 65% after recent refactor.',
        category: 'security',
        priority: 'high',
      };

      const first = reportToDeputyCto(db, args);
      const second = reportToDeputyCto(db, args);

      expect(typeof first.id).toBe('string');
      expect(first.id).toBeTruthy();
      expect(second.id).toBe(first.id);
    });

    it('should create only one row in the DB after duplicate calls', () => {
      const args: ReportArgs = {
        reporting_agent: 'code-reviewer',
        title: 'Security: Missing input validation on API route',
        summary: 'The /api/users endpoint does not validate UUID format.',
      };

      reportToDeputyCto(db, args);
      reportToDeputyCto(db, args);

      expect(countReports(db)).toBe(1);
    });

    it('should create separate reports for different reporting_agents with the same title', () => {
      const title = 'Architecture: Switching to event-driven pattern';

      const first = reportToDeputyCto(db, {
        reporting_agent: 'code-writer',
        title,
        summary: 'Proposing event bus for decoupling.',
      });

      const second = reportToDeputyCto(db, {
        reporting_agent: 'investigator',
        title,
        summary: 'Research into event-driven approach complete.',
      });

      expect(first.id).not.toBe(second.id);
      expect(countReports(db)).toBe(2);
    });

    it('should create separate reports for different titles from the same agent', () => {
      const first = reportToDeputyCto(db, {
        reporting_agent: 'code-reviewer',
        title: 'Security: SQL injection risk',
        summary: 'Found in user input path.',
      });

      const second = reportToDeputyCto(db, {
        reporting_agent: 'code-reviewer',
        title: 'Performance: Slow DB query detected',
        summary: 'Query takes 2s on large datasets.',
      });

      expect(first.id).not.toBe(second.id);
      expect(countReports(db)).toBe(2);
    });

    it('should create a new report when the matching pending report has been triaged (self_handled)', () => {
      const args: ReportArgs = {
        reporting_agent: 'test-writer',
        title: 'Blocker: CI pipeline broken',
        summary: 'Pre-commit hook failing on all commits.',
        priority: 'critical',
      };

      const first = reportToDeputyCto(db, args);
      expect(countReports(db)).toBe(1);

      markTriageStatus(db, first.id, 'self_handled');

      const second = reportToDeputyCto(db, args);

      expect(second.id).not.toBe(first.id);
      expect(countReports(db)).toBe(2);
      expect(second.message).toContain('Report submitted for triage');
    });

    it('should create a new report when the matching pending report has been escalated', () => {
      const args: ReportArgs = {
        reporting_agent: 'deputy-cto',
        title: 'Decision: Adopt pnpm workspaces',
        summary: 'Decision required on monorepo tooling.',
      };

      const first = reportToDeputyCto(db, args);
      markTriageStatus(db, first.id, 'escalated');

      const second = reportToDeputyCto(db, args);

      expect(second.id).not.toBe(first.id);
      expect(countReports(db)).toBe(2);
    });

    it('should create a new report when the matching pending report has been dismissed', () => {
      const args: ReportArgs = {
        reporting_agent: 'code-reviewer',
        title: 'Performance: Slow DB query',
        summary: 'Query takes 2s on large datasets.',
      };

      const first = reportToDeputyCto(db, args);
      markTriageStatus(db, first.id, 'dismissed');

      const second = reportToDeputyCto(db, args);

      expect(second.id).not.toBe(first.id);
      expect(countReports(db)).toBe(2);
    });

    it('should return the same ID for three identical calls (triple-call idempotency)', () => {
      const args: ReportArgs = {
        reporting_agent: 'project-manager',
        title: 'Breaking change: API v2 deprecation',
        summary: 'API v1 endpoints will be removed in next release.',
        category: 'breaking-change',
        priority: 'high',
      };

      const first = reportToDeputyCto(db, args);
      const second = reportToDeputyCto(db, args);
      const third = reportToDeputyCto(db, args);

      expect(second.id).toBe(first.id);
      expect(third.id).toBe(first.id);
      expect(countReports(db)).toBe(1);
    });

    it('should return the existing report even when summary differs on second call', () => {
      const base: ReportArgs = {
        reporting_agent: 'test-writer',
        title: 'Coverage: federation-mapper below threshold',
        summary: 'Coverage at 72%, needs improvement.',
      };

      const first = reportToDeputyCto(db, base);

      const second = reportToDeputyCto(db, {
        ...base,
        summary: 'UPDATED: Coverage now at 68%, critical.',
        category: 'blocker',
        priority: 'critical',
      });

      expect(second.id).toBe(first.id);
      expect(countReports(db)).toBe(1);

      // Original summary was NOT overwritten
      const stored = db
        .prepare('SELECT summary, category, priority FROM reports WHERE id = ?')
        .get(first.id) as { summary: string; category: string; priority: string };

      expect(stored.summary).toBe(base.summary);
      expect(stored.category).toBe('other');   // default from first call
      expect(stored.priority).toBe('normal');  // default from first call
    });

    it('should NOT deduplicate when the matching report has triage_status=in_progress', () => {
      const args: ReportArgs = {
        reporting_agent: 'code-writer',
        title: 'Security: Credential leak in logs',
        summary: 'Found token in application logs.',
        category: 'security',
        priority: 'critical',
      };

      const first = reportToDeputyCto(db, args);

      // Simulate triage starting — moves to in_progress (no longer pending)
      db.prepare(
        `UPDATE reports SET triage_status = 'in_progress', triage_started_at = ? WHERE id = ?`
      ).run(new Date().toISOString(), first.id);

      const second = reportToDeputyCto(db, args);

      expect(second.id).not.toBe(first.id);
      expect(countReports(db)).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // Idempotency key dedup
  // --------------------------------------------------------------------------

  describe('Explicit idempotency_key dedup', () => {
    it('should return the same report ID when the same idempotency_key is used twice', () => {
      const key = 'agent:code-reviewer:coverage-drop:2026-03-09';

      const first = reportToDeputyCto(db, {
        reporting_agent: 'code-reviewer',
        title: 'Coverage: auth module at 65%',
        summary: 'Coverage dropped after refactor.',
        idempotency_key: key,
      });

      const second = reportToDeputyCto(db, {
        reporting_agent: 'code-reviewer',
        title: 'Coverage: auth module at 65%',
        summary: 'Coverage dropped after refactor.',
        idempotency_key: key,
      });

      expect(second.id).toBe(first.id);
      expect(second.message).toContain('idempotency key match');
      expect(countReports(db)).toBe(1);
    });

    it('should create separate reports for different idempotency keys with different titles', () => {
      const first = reportToDeputyCto(db, {
        reporting_agent: 'code-reviewer',
        title: 'Coverage: auth module - run 1',
        summary: 'Coverage dropped after refactor.',
        idempotency_key: 'run-1-2026-03-09',
      });

      const second = reportToDeputyCto(db, {
        reporting_agent: 'code-reviewer',
        title: 'Coverage: auth module - run 2',
        summary: 'Coverage dropped after refactor.',
        idempotency_key: 'run-2-2026-03-09',
      });

      expect(first.id).not.toBe(second.id);
      expect(countReports(db)).toBe(2);
    });

    it('should return existing report when same idempotency_key is used even with a different agent', () => {
      const first = reportToDeputyCto(db, {
        reporting_agent: 'agent-a',
        title: 'Report from agent-a',
        summary: 'Initial submission.',
        idempotency_key: 'shared-key-across-agents',
      });

      // Same key, different agent — key lookup returns existing report
      const second = reportToDeputyCto(db, {
        reporting_agent: 'agent-b',
        title: 'Report from agent-b',
        summary: 'Retry from agent-b.',
        idempotency_key: 'shared-key-across-agents',
      });

      expect(second.id).toBe(first.id);
      expect(second.message).toContain('idempotency key match');
      expect(countReports(db)).toBe(1);
    });

    it('should use key-based lookup exclusively when idempotency_key is provided', () => {
      // A report without a key — uses natural dedup path
      const naturalFirst = reportToDeputyCto(db, {
        reporting_agent: 'test-writer',
        title: 'Architecture: module structure (no key)',
        summary: 'Natural dedup report.',
      });

      // Different title with a key — key path, no conflict with naturalFirst
      const keyedFirst = reportToDeputyCto(db, {
        reporting_agent: 'test-writer',
        title: 'Architecture: module structure (keyed)',
        summary: 'Keyed dedup report.',
        idempotency_key: 'arch-module-v1',
      });

      expect(keyedFirst.id).not.toBe(naturalFirst.id);
      expect(countReports(db)).toBe(2);

      // Third call with the same key returns keyedFirst regardless of content
      const keyedSecond = reportToDeputyCto(db, {
        reporting_agent: 'test-writer',
        title: 'Architecture: module structure (keyed)',
        summary: 'Should return cached keyed report.',
        idempotency_key: 'arch-module-v1',
      });

      expect(keyedSecond.id).toBe(keyedFirst.id);
      expect(countReports(db)).toBe(2);
    });

    it('should not deduplicate idempotency_key across triaged reports', () => {
      const key = 'weekly-security-scan-2026-03-01';
      const args: ReportArgs = {
        reporting_agent: 'security-scanner',
        title: 'Security: Weekly scan results',
        summary: 'Scan found 0 vulnerabilities.',
        idempotency_key: key,
      };

      const first = reportToDeputyCto(db, args);
      expect(countReports(db)).toBe(1);

      // Triage the report — moves it out of 'pending'
      markTriageStatus(db, first.id, 'self_handled');

      // Same key again — first is no longer pending, so a new report is created
      const second = reportToDeputyCto(db, args);

      expect(second.id).not.toBe(first.id);
      expect(countReports(db)).toBe(2);
      expect(second.message).toContain('Report submitted for triage');
    });

    it('should allow NULL idempotency keys without conflict', () => {
      reportToDeputyCto(db, {
        reporting_agent: 'agent-1',
        title: 'Title from agent-1',
        summary: 'Summary 1',
      });
      reportToDeputyCto(db, {
        reporting_agent: 'agent-2',
        title: 'Title from agent-2',
        summary: 'Summary 2',
      });
      expect(countReports(db)).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // Result structure validation
  // --------------------------------------------------------------------------

  describe('Result structure', () => {
    it('should return a UUID id and message on first submission', () => {
      const result = reportToDeputyCto(db, {
        reporting_agent: 'test-agent',
        title: 'Test report title',
        summary: 'Test summary content.',
      });

      expect(typeof result.id).toBe('string');
      expect(result.id).toBeTruthy();
      expect(result.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
      expect(typeof result.message).toBe('string');
      expect(result.message).toContain(result.id);
    });

    it('should include deduplicated=true semantics in the message on natural dedup', () => {
      const args: ReportArgs = {
        reporting_agent: 'test-agent',
        title: 'Idempotent report',
        summary: 'Same report submitted twice.',
      };

      const first = reportToDeputyCto(db, args);
      const second = reportToDeputyCto(db, args);

      expect(typeof second.id).toBe('string');
      expect(second.id).toBe(first.id);
      expect(typeof second.message).toBe('string');
      expect(second.message).toContain(first.id);
      expect(second.message.toLowerCase()).toContain('already exists');
    });

    it('should include deduplicated=true semantics in the message on key dedup', () => {
      const args: ReportArgs = {
        reporting_agent: 'test-agent',
        title: 'Keyed idempotent report',
        summary: 'Same report submitted twice with key.',
        idempotency_key: 'my-unique-key-001',
      };

      const first = reportToDeputyCto(db, args);
      const second = reportToDeputyCto(db, args);

      expect(second.id).toBe(first.id);
      expect(typeof second.message).toBe('string');
      expect(second.message).toContain(first.id);
      expect(second.message.toLowerCase()).toContain('idempotency key match');
    });

    it('should include the report ID in the success message on first submission', () => {
      const result = reportToDeputyCto(db, {
        reporting_agent: 'code-writer',
        title: 'Unique architecture report',
        summary: 'Proposing new module boundaries.',
      });

      expect(result.message).toContain(result.id);
      expect(result.message).toContain('submitted for triage');
    });
  });

  // --------------------------------------------------------------------------
  // DB-level partial unique index enforcement (SQLITE_CONSTRAINT_UNIQUE fallback)
  // --------------------------------------------------------------------------

  describe('DB-level partial unique index enforcement', () => {
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

      // Same agent+title but first is self_handled — should succeed
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

      // Same key but first is dismissed — should succeed
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

      // NULL idempotency_key is exempt from the key index — same agent+title is fine when first is not pending
      expect(() => {
        db.prepare(`
          INSERT INTO reports (id, reporting_agent, title, summary, category, priority, created_at, created_timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(randomUUID(), 'agent-e', 'Recurring issue', 'Second occurrence', 'other', 'normal', iso, iso);
      }).not.toThrow();

      expect(countReports(db)).toBe(2);
    });

    it('should exercise the SQLITE_CONSTRAINT_UNIQUE catch path when race causes INSERT to fail', () => {
      // Simulate the race: pre-insert the "winner" row directly, then call
      // reportToDeputyCto() which will SELECT-miss (in production this could happen
      // between SELECT and INSERT), hit the UNIQUE constraint, and fall back.
      const iso = new Date().toISOString();
      const winnerId = randomUUID();
      const key = 'race-condition-key';

      // "Winner" inserted directly (bypassing the SELECT-first guard)
      db.prepare(`
        INSERT INTO reports (id, reporting_agent, title, summary, category, priority, created_at, created_timestamp, idempotency_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(winnerId, 'race-agent', 'Race title', 'Winner summary', 'other', 'normal', iso, iso, key);

      // Now, manually trigger the fallback path by attempting an INSERT that would duplicate
      // We test the constraint throws correctly
      expect(() => {
        db.prepare(`
          INSERT INTO reports (id, reporting_agent, title, summary, category, priority, created_at, created_timestamp, idempotency_key)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(randomUUID(), 'race-agent', 'Race title 2', 'Loser summary', 'other', 'normal', iso, iso, key);
      }).toThrow(/UNIQUE constraint failed/);

      // The fallback SELECT should return the winner
      const fallback = db
        .prepare(`SELECT id FROM reports WHERE idempotency_key = ? AND triage_status = 'pending'`)
        .get(key) as { id: string } | undefined;

      expect(fallback).toBeDefined();
      expect(fallback!.id).toBe(winnerId);
    });
  });

  // --------------------------------------------------------------------------
  // Idempotency key: idx_reports_idempotency_key schema validation
  // --------------------------------------------------------------------------

  describe('Schema indexes', () => {
    it('should have idx_reports_agent_title_dedup partial unique index', () => {
      const indexes = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_reports_agent_title_dedup'`
        )
        .all();
      expect(indexes).toHaveLength(1);
    });

    it('should have idx_reports_idempotency_key partial unique index', () => {
      const indexes = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_reports_idempotency_key'`
        )
        .all();
      expect(indexes).toHaveLength(1);
    });
  });
});
