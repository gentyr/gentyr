/**
 * Deputy CTO Data Reader
 *
 * Queries cto-reports.db and deputy-cto.db for triage pipeline data.
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';

const PROJECT_DIR = path.resolve(process.env['CLAUDE_PROJECT_DIR'] || process.cwd());
const CTO_REPORTS_DB_PATH = path.join(PROJECT_DIR, '.claude', 'cto-reports.db');
const DEPUTY_CTO_DB_PATH = path.join(PROJECT_DIR, '.claude', 'deputy-cto.db');

// ============================================================================
// Types
// ============================================================================

export interface TriagedReport {
  id: string;
  title: string;
  priority: string;
  triage_status: string;
  triage_outcome: string | null;
  created_at: string;
  triage_completed_at: string | null;
}

export interface PendingQuestion {
  id: string;
  type: string;
  title: string;
  description: string;
  created_at: string;
}

export interface AnsweredQuestion {
  id: string;
  title: string;
  answer: string | null;
  answered_at: string;
  decided_by: string | null;
}

export interface DeputyCtoData {
  hasData: boolean;
  // Untriaged reports
  untriaged: TriagedReport[];
  untriagedCount: number;
  // Recently triaged (24h)
  recentlyTriaged: TriagedReport[];
  // Escalated reports (all time, still pending CTO attention)
  escalated: TriagedReport[];
  // 24h summary counts
  selfHandled24h: number;
  escalated24h: number;
  dismissed24h: number;
  // CTO questions
  pendingQuestions: PendingQuestion[];
  pendingQuestionCount: number;
  answeredQuestions: AnsweredQuestion[];
}

// ============================================================================
// Main
// ============================================================================

export function getDeputyCtoData(): DeputyCtoData {
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

  // Query cto-reports.db
  if (fs.existsSync(CTO_REPORTS_DB_PATH)) {
    let db: ReturnType<typeof Database> | null = null;
    try {
      db = new Database(CTO_REPORTS_DB_PATH, { readonly: true });

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

      // Escalated (all time, these need CTO attention)
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

      result.hasData = true;
    } catch {
      // Database may not exist or be corrupted
    } finally {
      db?.close();
    }
  }

  // Query deputy-cto.db for questions
  if (fs.existsSync(DEPUTY_CTO_DB_PATH)) {
    let db: ReturnType<typeof Database> | null = null;
    try {
      db = new Database(DEPUTY_CTO_DB_PATH, { readonly: true });

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

      result.hasData = true;
    } catch {
      // Database may not exist or be corrupted
    } finally {
      db?.close();
    }
  }

  return result;
}
