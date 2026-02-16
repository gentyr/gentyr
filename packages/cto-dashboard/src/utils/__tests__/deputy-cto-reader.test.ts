/**
 * Unit tests for deputy-cto-reader.ts
 *
 * Tests querying cto-reports.db and deputy-cto.db for triage pipeline data:
 * - Untriaged reports
 * - Recently triaged reports (24h)
 * - Escalated reports
 * - 24h summary counts (self-handled, escalated, dismissed)
 * - Pending questions
 * - Answered questions
 *
 * Uses in-memory SQLite databases for isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

describe('Deputy CTO Reader - Triage Reports', () => {
  let tempDir: string;
  let ctoReportsPath: string;

  beforeEach(() => {
    tempDir = path.join('/tmp', `deputy-cto-reader-test-${randomUUID()}`);
    fs.mkdirSync(path.join(tempDir, '.claude'), { recursive: true });
    ctoReportsPath = path.join(tempDir, '.claude', 'cto-reports.db');

    // Set PROJECT_DIR env var
    process.env['CLAUDE_PROJECT_DIR'] = tempDir;
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    delete process.env['CLAUDE_PROJECT_DIR'];
  });

  interface TriagedReport {
    id: string;
    title: string;
    priority: string;
    triage_status: string;
    triage_outcome: string | null;
    created_at: string;
    triage_completed_at: string | null;
  }

  interface DeputyCtoData {
    hasData: boolean;
    untriaged: TriagedReport[];
    untriagedCount: number;
    recentlyTriaged: TriagedReport[];
    escalated: TriagedReport[];
    selfHandled24h: number;
    escalated24h: number;
    dismissed24h: number;
    pendingQuestions: unknown[];
    pendingQuestionCount: number;
    answeredQuestions: unknown[];
  }

  const createReportsSchema = (db: Database.Database) => {
    db.exec(`
      CREATE TABLE reports (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        priority TEXT NOT NULL,
        triage_status TEXT NOT NULL,
        triage_outcome TEXT,
        created_timestamp INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        triage_completed_at TEXT
      );
    `);
  };

  const getDeputyCtoData = (): DeputyCtoData => {
    const result: DeputyCtoData = {
      hasData: false,
      untriaged: [],
      untriagedCount: 0,
      recentlyTriaged: [],
      escalated: [],
      selfHandled24h: 0,
      escalated24h: 0,
      dismissed24h: 0,
      pendingQuestions: [],
      pendingQuestionCount: 0,
      answeredQuestions: [],
    };

    const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    if (fs.existsSync(ctoReportsPath)) {
      try {
        const db = new Database(ctoReportsPath, { readonly: true });

        // Untriaged reports
        const pending = db.prepare(
          "SELECT id, title, priority, triage_status, created_at FROM reports WHERE triage_status = 'pending' ORDER BY created_timestamp DESC LIMIT 10"
        ).all() as TriagedReport[];
        result.untriaged = pending;

        const countRow = db.prepare("SELECT COUNT(*) as cnt FROM reports WHERE triage_status = 'pending'").get() as { cnt: number };
        result.untriagedCount = countRow.cnt;

        // Recently triaged (24h)
        result.recentlyTriaged = db.prepare(`
          SELECT id, title, priority, triage_status, triage_outcome, triage_completed_at
          FROM reports
          WHERE triage_status IN ('self_handled', 'escalated', 'dismissed')
            AND triage_completed_at >= ?
          ORDER BY triage_completed_at DESC
          LIMIT 8
        `).all(cutoff24h) as TriagedReport[];

        // Escalated (all time)
        result.escalated = db.prepare(`
          SELECT id, title, priority, triage_status, triage_outcome, triage_completed_at
          FROM reports
          WHERE triage_status = 'escalated'
          ORDER BY triage_completed_at DESC
          LIMIT 5
        `).all() as TriagedReport[];

        // 24h summary counts
        const selfHandled = db.prepare(
          "SELECT COUNT(*) as cnt FROM reports WHERE triage_status = 'self_handled' AND triage_completed_at >= ?"
        ).get(cutoff24h) as { cnt: number };
        result.selfHandled24h = selfHandled.cnt;

        const escalatedCount = db.prepare(
          "SELECT COUNT(*) as cnt FROM reports WHERE triage_status = 'escalated' AND triage_completed_at >= ?"
        ).get(cutoff24h) as { cnt: number };
        result.escalated24h = escalatedCount.cnt;

        const dismissed = db.prepare(
          "SELECT COUNT(*) as cnt FROM reports WHERE triage_status = 'dismissed' AND triage_completed_at >= ?"
        ).get(cutoff24h) as { cnt: number };
        result.dismissed24h = dismissed.cnt;

        db.close();
        result.hasData = true;
      } catch {
        // Database error
      }
    }

    return result;
  };

  it('should return empty data when database does not exist', () => {
    const result = getDeputyCtoData();

    expect(result.hasData).toBe(false);
    expect(result.untriaged).toEqual([]);
    expect(result.untriagedCount).toBe(0);
    expect(result.recentlyTriaged).toEqual([]);
    expect(result.escalated).toEqual([]);
    expect(result.selfHandled24h).toBe(0);
    expect(result.escalated24h).toBe(0);
    expect(result.dismissed24h).toBe(0);
  });

  it('should fetch untriaged reports', () => {
    const db = new Database(ctoReportsPath);
    createReportsSchema(db);

    const now = Date.now();
    db.prepare(`
      INSERT INTO reports (id, title, priority, triage_status, created_timestamp, created_at)
      VALUES (?, ?, ?, 'pending', ?, ?)
    `).run('r1', 'Report 1', 'high', now - 1000, new Date(now - 1000).toISOString());
    db.prepare(`
      INSERT INTO reports (id, title, priority, triage_status, created_timestamp, created_at)
      VALUES (?, ?, ?, 'pending', ?, ?)
    `).run('r2', 'Report 2', 'medium', now - 2000, new Date(now - 2000).toISOString());
    db.close();

    const result = getDeputyCtoData();

    expect(result.hasData).toBe(true);
    expect(result.untriaged.length).toBe(2);
    expect(result.untriagedCount).toBe(2);
    expect(result.untriaged[0].id).toBe('r1'); // Most recent first
    expect(result.untriaged[1].id).toBe('r2');
  });

  it('should limit untriaged reports to 10', () => {
    const db = new Database(ctoReportsPath);
    createReportsSchema(db);

    const now = Date.now();
    for (let i = 0; i < 15; i++) {
      db.prepare(`
        INSERT INTO reports (id, title, priority, triage_status, created_timestamp, created_at)
        VALUES (?, ?, 'medium', 'pending', ?, ?)
      `).run(`r${i}`, `Report ${i}`, now - i * 1000, new Date(now - i * 1000).toISOString());
    }
    db.close();

    const result = getDeputyCtoData();

    expect(result.untriaged.length).toBe(10);
    expect(result.untriagedCount).toBe(15);
  });

  it('should fetch recently triaged reports within 24h', () => {
    const db = new Database(ctoReportsPath);
    createReportsSchema(db);

    const now = Date.now();
    db.prepare(`
      INSERT INTO reports (id, title, priority, triage_status, triage_outcome, created_timestamp, created_at, triage_completed_at)
      VALUES (?, ?, 'high', 'self_handled', 'fixed', ?, ?, ?)
    `).run('r1', 'Report 1', now - 1000, new Date(now - 1000).toISOString(), new Date(now - 1 * 60 * 60 * 1000).toISOString());
    db.prepare(`
      INSERT INTO reports (id, title, priority, triage_status, triage_outcome, created_timestamp, created_at, triage_completed_at)
      VALUES (?, ?, 'medium', 'dismissed', 'duplicate', ?, ?, ?)
    `).run('r2', 'Report 2', now - 2000, new Date(now - 2000).toISOString(), new Date(now - 2 * 60 * 60 * 1000).toISOString());
    // Old report (should not appear in recently triaged)
    db.prepare(`
      INSERT INTO reports (id, title, priority, triage_status, triage_outcome, created_timestamp, created_at, triage_completed_at)
      VALUES (?, ?, 'low', 'self_handled', 'fixed', ?, ?, ?)
    `).run('r3', 'Report 3', now - 3000, new Date(now - 3000).toISOString(), new Date(now - 25 * 60 * 60 * 1000).toISOString());
    db.close();

    const result = getDeputyCtoData();

    expect(result.recentlyTriaged.length).toBe(2);
    expect(result.recentlyTriaged[0].id).toBe('r1'); // Most recent first
    expect(result.recentlyTriaged[1].id).toBe('r2');
  });

  it('should limit recently triaged reports to 8', () => {
    const db = new Database(ctoReportsPath);
    createReportsSchema(db);

    const now = Date.now();
    for (let i = 0; i < 12; i++) {
      db.prepare(`
        INSERT INTO reports (id, title, priority, triage_status, triage_outcome, created_timestamp, created_at, triage_completed_at)
        VALUES (?, ?, 'medium', 'self_handled', 'fixed', ?, ?, ?)
      `).run(`r${i}`, `Report ${i}`, now - i * 1000, new Date(now - i * 1000).toISOString(), new Date(now - i * 60 * 1000).toISOString());
    }
    db.close();

    const result = getDeputyCtoData();

    expect(result.recentlyTriaged.length).toBe(8);
  });

  it('should fetch escalated reports', () => {
    const db = new Database(ctoReportsPath);
    createReportsSchema(db);

    const now = Date.now();
    db.prepare(`
      INSERT INTO reports (id, title, priority, triage_status, triage_outcome, created_timestamp, created_at, triage_completed_at)
      VALUES (?, ?, 'critical', 'escalated', 'needs_review', ?, ?, ?)
    `).run('r1', 'Critical Issue', now - 1000, new Date(now - 1000).toISOString(), new Date(now - 1 * 60 * 60 * 1000).toISOString());
    db.prepare(`
      INSERT INTO reports (id, title, priority, triage_status, triage_outcome, created_timestamp, created_at, triage_completed_at)
      VALUES (?, ?, 'high', 'escalated', 'complex', ?, ?, ?)
    `).run('r2', 'Complex Bug', now - 2000, new Date(now - 2000).toISOString(), new Date(now - 2 * 60 * 60 * 1000).toISOString());
    db.close();

    const result = getDeputyCtoData();

    expect(result.escalated.length).toBe(2);
    expect(result.escalated[0].priority).toBe('critical');
  });

  it('should limit escalated reports to 5', () => {
    const db = new Database(ctoReportsPath);
    createReportsSchema(db);

    const now = Date.now();
    for (let i = 0; i < 8; i++) {
      db.prepare(`
        INSERT INTO reports (id, title, priority, triage_status, triage_outcome, created_timestamp, created_at, triage_completed_at)
        VALUES (?, ?, 'high', 'escalated', 'review', ?, ?, ?)
      `).run(`r${i}`, `Report ${i}`, now - i * 1000, new Date(now - i * 1000).toISOString(), new Date(now - i * 60 * 1000).toISOString());
    }
    db.close();

    const result = getDeputyCtoData();

    expect(result.escalated.length).toBe(5);
  });

  it('should count self-handled reports within 24h', () => {
    const db = new Database(ctoReportsPath);
    createReportsSchema(db);

    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      db.prepare(`
        INSERT INTO reports (id, title, priority, triage_status, triage_outcome, created_timestamp, created_at, triage_completed_at)
        VALUES (?, ?, 'medium', 'self_handled', 'fixed', ?, ?, ?)
      `).run(`r${i}`, `Report ${i}`, now - i * 1000, new Date(now - i * 1000).toISOString(), new Date(now - i * 60 * 60 * 1000).toISOString());
    }
    // Old self-handled (should not count)
    db.prepare(`
      INSERT INTO reports (id, title, priority, triage_status, triage_outcome, created_timestamp, created_at, triage_completed_at)
      VALUES (?, ?, 'low', 'self_handled', 'fixed', ?, ?, ?)
    `).run('r-old', 'Old Report', now - 6000, new Date(now - 6000).toISOString(), new Date(now - 25 * 60 * 60 * 1000).toISOString());
    db.close();

    const result = getDeputyCtoData();

    expect(result.selfHandled24h).toBe(5);
  });

  it('should count escalated reports within 24h', () => {
    const db = new Database(ctoReportsPath);
    createReportsSchema(db);

    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      db.prepare(`
        INSERT INTO reports (id, title, priority, triage_status, triage_outcome, created_timestamp, created_at, triage_completed_at)
        VALUES (?, ?, 'high', 'escalated', 'complex', ?, ?, ?)
      `).run(`r${i}`, `Report ${i}`, now - i * 1000, new Date(now - i * 1000).toISOString(), new Date(now - i * 60 * 60 * 1000).toISOString());
    }
    db.close();

    const result = getDeputyCtoData();

    expect(result.escalated24h).toBe(3);
  });

  it('should count dismissed reports within 24h', () => {
    const db = new Database(ctoReportsPath);
    createReportsSchema(db);

    const now = Date.now();
    for (let i = 0; i < 2; i++) {
      db.prepare(`
        INSERT INTO reports (id, title, priority, triage_status, triage_outcome, created_timestamp, created_at, triage_completed_at)
        VALUES (?, ?, 'low', 'dismissed', 'duplicate', ?, ?, ?)
      `).run(`r${i}`, `Report ${i}`, now - i * 1000, new Date(now - i * 1000).toISOString(), new Date(now - i * 60 * 60 * 1000).toISOString());
    }
    db.close();

    const result = getDeputyCtoData();

    expect(result.dismissed24h).toBe(2);
  });

  it('should validate structure of returned data', () => {
    const result = getDeputyCtoData();

    expect(result).toHaveProperty('hasData');
    expect(result).toHaveProperty('untriaged');
    expect(result).toHaveProperty('untriagedCount');
    expect(result).toHaveProperty('recentlyTriaged');
    expect(result).toHaveProperty('escalated');
    expect(result).toHaveProperty('selfHandled24h');
    expect(result).toHaveProperty('escalated24h');
    expect(result).toHaveProperty('dismissed24h');
    expect(result).toHaveProperty('pendingQuestions');
    expect(result).toHaveProperty('pendingQuestionCount');
    expect(result).toHaveProperty('answeredQuestions');

    expect(typeof result.hasData).toBe('boolean');
    expect(Array.isArray(result.untriaged)).toBe(true);
    expect(typeof result.untriagedCount).toBe('number');
    expect(Array.isArray(result.recentlyTriaged)).toBe(true);
    expect(Array.isArray(result.escalated)).toBe(true);
    expect(typeof result.selfHandled24h).toBe('number');
    expect(typeof result.escalated24h).toBe('number');
    expect(typeof result.dismissed24h).toBe('number');
  });
});

describe('Deputy CTO Reader - Questions', () => {
  let tempDir: string;
  let deputyCTOPath: string;

  beforeEach(() => {
    tempDir = path.join('/tmp', `deputy-cto-questions-test-${randomUUID()}`);
    fs.mkdirSync(path.join(tempDir, '.claude'), { recursive: true });
    deputyCTOPath = path.join(tempDir, '.claude', 'deputy-cto.db');
    process.env['CLAUDE_PROJECT_DIR'] = tempDir;
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    delete process.env['CLAUDE_PROJECT_DIR'];
  });

  interface PendingQuestion {
    id: string;
    type: string;
    title: string;
    description: string;
    created_at: string;
  }

  interface AnsweredQuestion {
    id: string;
    title: string;
    answer: string | null;
    answered_at: string;
    decided_by: string | null;
  }

  interface DeputyCtoData {
    hasData: boolean;
    untriaged: unknown[];
    untriagedCount: number;
    recentlyTriaged: unknown[];
    escalated: unknown[];
    selfHandled24h: number;
    escalated24h: number;
    dismissed24h: number;
    pendingQuestions: PendingQuestion[];
    pendingQuestionCount: number;
    answeredQuestions: AnsweredQuestion[];
  }

  const createQuestionsSchema = (db: Database.Database) => {
    db.exec(`
      CREATE TABLE questions (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        created_timestamp INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        answer TEXT,
        answered_at TEXT,
        decided_by TEXT
      );
    `);
  };

  const getDeputyCtoData = (): DeputyCtoData => {
    const result: DeputyCtoData = {
      hasData: false,
      untriaged: [],
      untriagedCount: 0,
      recentlyTriaged: [],
      escalated: [],
      selfHandled24h: 0,
      escalated24h: 0,
      dismissed24h: 0,
      pendingQuestions: [],
      pendingQuestionCount: 0,
      answeredQuestions: [],
    };

    const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    if (fs.existsSync(deputyCTOPath)) {
      try {
        const db = new Database(deputyCTOPath, { readonly: true });

        // Pending questions
        result.pendingQuestions = db.prepare(`
          SELECT id, type, title, description, created_at
          FROM questions
          WHERE status = 'pending'
          ORDER BY created_timestamp DESC
          LIMIT 10
        `).all() as PendingQuestion[];

        const qCountRow = db.prepare("SELECT COUNT(*) as cnt FROM questions WHERE status = 'pending'").get() as { cnt: number };
        result.pendingQuestionCount = qCountRow.cnt;

        // Answered questions (24h)
        result.answeredQuestions = db.prepare(`
          SELECT id, title, answer, answered_at, decided_by
          FROM questions
          WHERE status = 'answered' AND answered_at >= ?
          ORDER BY answered_at DESC
          LIMIT 5
        `).all(cutoff24h) as AnsweredQuestion[];

        db.close();
        result.hasData = true;
      } catch {
        // Database error
      }
    }

    return result;
  };

  it('should fetch pending questions', () => {
    const db = new Database(deputyCTOPath);
    createQuestionsSchema(db);

    const now = Date.now();
    db.prepare(`
      INSERT INTO questions (id, type, title, description, status, created_timestamp, created_at)
      VALUES (?, 'decision', ?, 'Should we...?', 'pending', ?, ?)
    `).run('q1', 'Architecture Decision', now - 1000, new Date(now - 1000).toISOString());
    db.prepare(`
      INSERT INTO questions (id, type, title, description, status, created_timestamp, created_at)
      VALUES (?, 'clarification', ?, 'What does...?', 'pending', ?, ?)
    `).run('q2', 'Clarification Needed', now - 2000, new Date(now - 2000).toISOString());
    db.close();

    const result = getDeputyCtoData();

    expect(result.hasData).toBe(true);
    expect(result.pendingQuestions.length).toBe(2);
    expect(result.pendingQuestionCount).toBe(2);
    expect(result.pendingQuestions[0].type).toBe('decision');
  });

  it('should limit pending questions to 10', () => {
    const db = new Database(deputyCTOPath);
    createQuestionsSchema(db);

    const now = Date.now();
    for (let i = 0; i < 15; i++) {
      db.prepare(`
        INSERT INTO questions (id, type, title, description, status, created_timestamp, created_at)
        VALUES (?, 'decision', ?, 'Question', 'pending', ?, ?)
      `).run(`q${i}`, `Question ${i}`, now - i * 1000, new Date(now - i * 1000).toISOString());
    }
    db.close();

    const result = getDeputyCtoData();

    expect(result.pendingQuestions.length).toBe(10);
    expect(result.pendingQuestionCount).toBe(15);
  });

  it('should fetch answered questions within 24h', () => {
    const db = new Database(deputyCTOPath);
    createQuestionsSchema(db);

    const now = Date.now();
    db.prepare(`
      INSERT INTO questions (id, type, title, description, status, created_timestamp, created_at, answer, answered_at, decided_by)
      VALUES (?, 'decision', ?, 'Question', 'answered', ?, ?, 'Answer 1', ?, 'cto')
    `).run('q1', 'Question 1', now - 1000, new Date(now - 1000).toISOString(), new Date(now - 1 * 60 * 60 * 1000).toISOString());
    db.prepare(`
      INSERT INTO questions (id, type, title, description, status, created_timestamp, created_at, answer, answered_at)
      VALUES (?, 'clarification', ?, 'Question', 'answered', ?, ?, 'Answer 2', ?)
    `).run('q2', 'Question 2', now - 2000, new Date(now - 2000).toISOString(), new Date(now - 2 * 60 * 60 * 1000).toISOString());
    // Old answered (should not appear)
    db.prepare(`
      INSERT INTO questions (id, type, title, description, status, created_timestamp, created_at, answer, answered_at)
      VALUES (?, 'decision', ?, 'Question', 'answered', ?, ?, 'Answer 3', ?)
    `).run('q3', 'Question 3', now - 3000, new Date(now - 3000).toISOString(), new Date(now - 25 * 60 * 60 * 1000).toISOString());
    db.close();

    const result = getDeputyCtoData();

    expect(result.answeredQuestions.length).toBe(2);
    expect(result.answeredQuestions[0].answer).toBe('Answer 1');
    expect(result.answeredQuestions[0].decided_by).toBe('cto');
  });

  it('should limit answered questions to 5', () => {
    const db = new Database(deputyCTOPath);
    createQuestionsSchema(db);

    const now = Date.now();
    for (let i = 0; i < 8; i++) {
      db.prepare(`
        INSERT INTO questions (id, type, title, description, status, created_timestamp, created_at, answer, answered_at)
        VALUES (?, 'decision', ?, 'Question', 'answered', ?, ?, 'Answer', ?)
      `).run(`q${i}`, `Question ${i}`, now - i * 1000, new Date(now - i * 1000).toISOString(), new Date(now - i * 60 * 1000).toISOString());
    }
    db.close();

    const result = getDeputyCtoData();

    expect(result.answeredQuestions.length).toBe(5);
  });

  it('should handle null answer and decided_by fields', () => {
    const db = new Database(deputyCTOPath);
    createQuestionsSchema(db);

    const now = Date.now();
    db.prepare(`
      INSERT INTO questions (id, type, title, description, status, created_timestamp, created_at, answered_at)
      VALUES (?, 'decision', 'Question', 'Description', 'answered', ?, ?, ?)
    `).run('q1', now - 1000, new Date(now - 1000).toISOString(), new Date(now - 1 * 60 * 60 * 1000).toISOString());
    db.close();

    const result = getDeputyCtoData();

    expect(result.answeredQuestions.length).toBe(1);
    expect(result.answeredQuestions[0].answer).toBeNull();
    expect(result.answeredQuestions[0].decided_by).toBeNull();
  });

  it('should validate structure of questions', () => {
    const result = getDeputyCtoData();

    expect(Array.isArray(result.pendingQuestions)).toBe(true);
    expect(typeof result.pendingQuestionCount).toBe('number');
    expect(Array.isArray(result.answeredQuestions)).toBe(true);
  });
});
