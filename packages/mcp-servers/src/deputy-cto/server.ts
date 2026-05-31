#!/usr/bin/env node
/**
 * Deputy-CTO MCP Server
 *
 * Private toolset for the deputy-cto agent to manage CTO questions,
 * commit approvals/rejections, and task spawning.
 *
 * IMPORTANT: This server should only be used by the deputy-cto skill/agent.
 * Other agents should use agent-reports (mcp__agent-reports__report_to_deputy_cto)
 * to submit reports for triage, not this server.
 *
 * Features:
 * - Question queue for CTO decisions/approvals
 * - Commit approval/rejection with automatic question creation on reject
 * - Task spawning for implementing CTO feedback
 * - Commit blocking when rejections are pending
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (stdio MCP)
 *
 * @version 1.0.0
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';

const { randomUUID } = crypto;
import Database from 'better-sqlite3';
import { openReadonlyDb } from '../shared/readonly-db.js';
import { McpServer, type AnyToolHandler } from '../shared/server.js';
import {
  AddQuestionArgsSchema,
  ListQuestionsArgsSchema,
  ReadQuestionArgsSchema,
  AnswerQuestionArgsSchema,
  ClearQuestionArgsSchema,
  ApproveCommitArgsSchema,
  RejectCommitArgsSchema,
  GetCommitDecisionArgsSchema,
  GetPendingCountArgsSchema,
  ToggleAutonomousModeArgsSchema,
  GetAutonomousModeStatusArgsSchema,
  RecordCtoBriefingArgsSchema,
  SearchClearedItemsArgsSchema,
  UpdateQuestionArgsSchema,
  ResolveQuestionArgsSchema,
  CleanupOldRecordsArgsSchema,
  SetAutomationModeArgsSchema,
  ListAutomationConfigArgsSchema,
  GetMergeChainStatusArgsSchema,
  type AddQuestionArgs,
  type ListQuestionsArgs,
  type ReadQuestionArgs,
  type AnswerQuestionArgs,
  type ClearQuestionArgs,
  type ApproveCommitArgs,
  type RejectCommitArgs,
  type ToggleAutonomousModeArgs,
  type SearchClearedItemsArgs,
  type UpdateQuestionArgs,
  type ResolveQuestionArgs,
  type SetAutomationModeArgs,
  type GetMergeChainStatusArgs,
  type QuestionRecord,
  type QuestionListItem,
  type ListQuestionsResult,
  type AddQuestionResult,
  type ReadQuestionResult,
  type AnswerQuestionResult,
  type ClearQuestionResult,
  type ApproveCommitResult,
  type RejectCommitResult,
  type GetCommitDecisionResult,
  type GetPendingCountResult,
  type ToggleAutonomousModeResult,
  type GetAutonomousModeStatusResult,
  type RecordCtoBriefingResult,
  type SearchClearedItemsResult,
  type UpdateQuestionResult,
  type ResolveQuestionResult,
  type CleanupOldRecordsResult,
  type SetAutomationModeResult,
  type AutomationConfigItem,
  type ListAutomationConfigResult,
  type AutomationModeEntry,
  type ClearedQuestionItem,
  type AutonomousModeConfig,
  type ErrorResult,
  TriggerPreviewPromotionArgsSchema,
  type TriggerPreviewPromotionArgs,
  type TriggerPreviewPromotionResult,
} from './types.js';

// ============================================================================
// Configuration
// ============================================================================

const PROJECT_DIR = path.resolve(process.env['CLAUDE_PROJECT_DIR'] || process.cwd());
const DB_PATH = path.join(PROJECT_DIR, '.claude', 'deputy-cto.db');
const CTO_REPORTS_DB_PATH = path.join(PROJECT_DIR, '.claude', 'cto-reports.db');
const AUTONOMOUS_CONFIG_PATH = path.join(PROJECT_DIR, '.claude', 'autonomous-mode.json');
const AUTOMATION_CONFIG_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'automation-config.json');
const AUTOMATION_STATE_PATH = path.join(PROJECT_DIR, '.claude', 'hourly-automation-state.json');
const COOLDOWN_MINUTES = 55;

// ============================================================================
// Database Schema
// ============================================================================

const SCHEMA = `
CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    context TEXT,
    suggested_options TEXT,
    recommendation TEXT,
    answer TEXT,
    created_at TEXT NOT NULL,
    created_timestamp TEXT NOT NULL,
    answered_at TEXT,
    decided_by TEXT,
    investigation_task_id TEXT,
    CONSTRAINT valid_type CHECK (type IN ('decision', 'approval', 'rejection', 'question', 'escalation', 'bypass-request', 'protected-action-request')),
    CONSTRAINT valid_status CHECK (status IN ('pending', 'answered')),
    CONSTRAINT valid_decided_by CHECK (decided_by IS NULL OR decided_by IN ('cto', 'deputy-cto'))
);

CREATE TABLE IF NOT EXISTS commit_decisions (
    id TEXT PRIMARY KEY,
    decision TEXT NOT NULL,
    rationale TEXT NOT NULL,
    question_id TEXT,
    created_at TEXT NOT NULL,
    created_timestamp TEXT NOT NULL,
    CONSTRAINT valid_decision CHECK (decision IN ('approved', 'rejected'))
);

CREATE TABLE IF NOT EXISTS cleared_questions (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    recommendation TEXT,
    answer TEXT,
    answered_at TEXT,
    decided_by TEXT,
    cleared_at TEXT NOT NULL,
    cleared_timestamp TEXT NOT NULL,
    CONSTRAINT valid_decided_by CHECK (decided_by IS NULL OR decided_by IN ('cto', 'deputy-cto'))
);

CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status);
CREATE INDEX IF NOT EXISTS idx_cleared_questions_cleared ON cleared_questions(cleared_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_questions_type ON questions(type);
CREATE INDEX IF NOT EXISTS idx_commit_decisions_created ON commit_decisions(created_timestamp DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_questions_type_title_dedup
  ON questions(type, title) WHERE status != 'answered';

CREATE TABLE IF NOT EXISTS spawned_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  description TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  pid INTEGER,
  status TEXT NOT NULL DEFAULT 'spawned',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_spawned_tasks_description_active
  ON spawned_tasks(description) WHERE status = 'spawned';
`;

// ============================================================================
// Database Management
// ============================================================================

let _db: Database.Database | null = null;

function initializeDatabase(): Database.Database {
  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);

  // Migration: Convert any existing INTEGER timestamps to ISO 8601 TEXT (G005)
  db.exec(`UPDATE questions SET created_timestamp = datetime(created_timestamp, 'unixepoch') || 'Z' WHERE typeof(created_timestamp) = 'integer'`);
  db.exec(`UPDATE commit_decisions SET created_timestamp = datetime(created_timestamp, 'unixepoch') || 'Z' WHERE typeof(created_timestamp) = 'integer'`);
  db.exec(`UPDATE cleared_questions SET cleared_timestamp = datetime(cleared_timestamp, 'unixepoch') || 'Z' WHERE typeof(cleared_timestamp) = 'integer'`);

  // Migration: Add decided_by column if it doesn't exist (for existing databases)
  const questionsColumns = db.pragma('table_info(questions)') as { name: string }[];
  if (!questionsColumns.some(c => c.name === 'decided_by')) {
    db.exec('ALTER TABLE questions ADD COLUMN decided_by TEXT');
  }
  if (!questionsColumns.some(c => c.name === 'recommendation')) {
    db.exec('ALTER TABLE questions ADD COLUMN recommendation TEXT');
  }
  if (!questionsColumns.some(c => c.name === 'investigation_task_id')) {
    db.exec('ALTER TABLE questions ADD COLUMN investigation_task_id TEXT');
  }
  const clearedColumns = db.pragma('table_info(cleared_questions)') as { name: string }[];
  if (!clearedColumns.some(c => c.name === 'decided_by')) {
    db.exec('ALTER TABLE cleared_questions ADD COLUMN decided_by TEXT');
  }
  if (!clearedColumns.some(c => c.name === 'recommendation')) {
    db.exec('ALTER TABLE cleared_questions ADD COLUMN recommendation TEXT');
  }

  // Run cleanup on startup to prevent unbounded database growth
  // This is safe to call on every startup (idempotent)
  const cleanup = cleanupOldRecordsInternal(db);
  if (cleanup.commit_decisions_deleted > 0 || cleanup.cleared_questions_deleted > 0 || cleanup.bypass_requests_expired > 0 || cleanup.spawned_tasks_deleted > 0) {
    console.error(`[deputy-cto] Startup cleanup: ${cleanup.message}`);
  }

  return db;
}

function getDb(): Database.Database {
  if (!_db) {
    _db = initializeDatabase();
  }
  return _db;
}

function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

interface CountResult { count: number }

function getPendingRejectionCount(): number {
  const db = getDb();
  const result = db.prepare(
    "SELECT COUNT(*) as count FROM questions WHERE type = 'rejection' AND status = 'pending'"
  ).get() as CountResult;
  return result.count;
}

function getPendingCount(): number {
  const db = getDb();
  // Expire stale bypass requests before counting to prevent dead agents from blocking commits
  expireStaleBypassRequests(db);
  const result = db.prepare(
    "SELECT COUNT(*) as count FROM questions WHERE status = 'pending'"
  ).get() as CountResult;
  return result.count;
}

function getPendingTriageCount(): number {
  // G020: Pending triage items also block commits
  // G001: If database doesn't exist yet, no triage items to block on (valid startup state)
  if (!fs.existsSync(CTO_REPORTS_DB_PATH)) {
    return 0;
  }
  try {
    const reportsDb = openReadonlyDb(CTO_REPORTS_DB_PATH);
    // Check if triage_status column exists
    const columns = reportsDb.pragma('table_info(reports)') as { name: string }[];
    const hasTriageStatus = columns.some(c => c.name === 'triage_status');

    let count = 0;
    if (hasTriageStatus) {
      const { count: triageCount } = reportsDb.prepare(
        "SELECT COUNT(*) as count FROM reports WHERE triage_status = 'pending'"
      ).get() as CountResult;
      count = triageCount;
    } else {
      // Fallback for databases without triage_status column
      const { count: triageCount } = reportsDb.prepare(
        "SELECT COUNT(*) as count FROM reports WHERE triaged_at IS NULL"
      ).get() as CountResult;
      count = triageCount;
    }
    reportsDb.close();
    return count;
  } catch (err) {
    // G001: Fail closed - if we can't read triage count, assume there are pending items
    // This blocks commits when the database is corrupted/unreadable (safer default)
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[deputy-cto] G001: Failed to read triage count, blocking commits: ${message}\n`);
    return 1; // Return 1 to trigger commit blocking
  }
}

function getTotalPendingItems(): { questions: number; triage: number; total: number } {
  const questions = getPendingCount();
  const triage = getPendingTriageCount();
  return { questions, triage, total: questions + triage };
}

function clearLatestCommitDecision(): void {
  const db = getDb();
  // Clear the most recent commit decision so a new one can be made
  db.prepare(`
    DELETE FROM commit_decisions WHERE id IN (
      SELECT id FROM commit_decisions ORDER BY created_timestamp DESC LIMIT 1
    )
  `).run();
}

// ============================================================================
// Tool Implementations
// ============================================================================

function addQuestion(args: AddQuestionArgs): AddQuestionResult | ErrorResult {
  const db = getDb();

  // Require recommendation for escalations
  if (args.type === 'escalation' && !args.recommendation) {
    return { error: 'Escalations require a recommendation. Provide a concise statement of what you recommend and why.' };
  }

  // Block agents from creating bypass-request or protected-action-request via add_question
  if (args.type === 'bypass-request') {
    return { error: 'Cannot create bypass-request questions via add_question. Use request_bypass instead.' };
  }
  if (args.type === 'protected-action-request') {
    return { error: 'Cannot create protected-action-request questions via add_question. These are created by the protected-action hook.' };
  }

  const id = randomUUID();
  const now = new Date();
  const created_at = now.toISOString();
  const created_timestamp = now.toISOString();

  try {
    db.prepare(`
      INSERT INTO questions (id, type, status, title, description, context, suggested_options, recommendation, investigation_task_id, created_at, created_timestamp)
      VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      args.type,
      args.title,
      args.description,
      args.context ?? null,
      args.suggested_options ? JSON.stringify(args.suggested_options) : null,
      args.recommendation ?? null,
      args.investigation_task_id ?? null,
      created_at,
      created_timestamp
    );
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      (err as Error & { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
    ) {
      // Fallback: return the record that won the race
      const fallback = db.prepare(`
        SELECT id FROM questions WHERE type = ? AND title = ? AND status != 'answered' LIMIT 1
      `).get(args.type, args.title) as { id: string } | undefined;
      if (fallback) {return {
        id: fallback.id,
        message: `Question already exists for CTO (deduplicated). ID: ${fallback.id}`,
      };}
    }
    throw err; // Re-throw unexpected errors
  }

  return {
    id,
    message: `Question added for CTO. ID: ${id}`,
  };
}

function listQuestions(args: ListQuestionsArgs): ListQuestionsResult {
  const db = getDb();

  let sql = 'SELECT id, type, status, title, created_at FROM questions';
  const params: unknown[] = [];

  if (!args.include_answered) {
    sql += " WHERE status = 'pending'";
  }

  sql += ' ORDER BY created_timestamp DESC LIMIT ?';
  params.push(args.limit ?? 20);

  const questions = db.prepare(sql).all(...params) as QuestionRecord[];

  const pendingCount = getPendingCount();
  const rejectionCount = getPendingRejectionCount();
  const pendingTriage = getPendingTriageCount();

  const items: QuestionListItem[] = questions.map(q => ({
    id: q.id,
    type: q.type,
    status: q.status,
    title: q.title,
    created_at: q.created_at,
    is_rejection: q.type === 'rejection',
  }));

  return {
    questions: items,
    total: items.length,
    pending_count: pendingCount,
    rejection_count: rejectionCount,
    // G020: Block commits when ANY pending items exist (questions OR triage)
    commits_blocked: pendingCount > 0 || pendingTriage > 0,
  };
}

function readQuestion(args: ReadQuestionArgs): ReadQuestionResult | ErrorResult {
  const db = getDb();
  const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(args.id) as QuestionRecord | undefined;

  if (!question) {
    return { error: `Question not found: ${args.id}` };
  }

  return {
    id: question.id,
    type: question.type,
    status: question.status,
    title: question.title,
    description: question.description,
    context: question.context,
    suggested_options: question.suggested_options ? JSON.parse(question.suggested_options) : null,
    recommendation: question.recommendation,
    answer: question.answer,
    created_at: question.created_at,
    answered_at: question.answered_at,
    investigation_task_id: question.investigation_task_id ?? null,
  };
}

function answerQuestion(args: AnswerQuestionArgs): AnswerQuestionResult | ErrorResult {
  const db = getDb();
  const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(args.id) as QuestionRecord | undefined;

  if (!question) {
    return { error: `Question not found: ${args.id}` };
  }

  // Block answering bypass-request and protected-action-request questions via this tool

  if (question.status === 'answered') {
    return {
      id: args.id,
      answered: true,
      message: `Question already answered at ${question.answered_at}`,
    };
  }

  const now = new Date().toISOString();
  const decidedBy = args.decided_by ?? 'cto';
  db.prepare(`
    UPDATE questions SET status = 'answered', answer = ?, answered_at = ?, decided_by = ?
    WHERE id = ?
  `).run(args.answer, now, decidedBy, args.id);

  return {
    id: args.id,
    answered: true,
    message: `Answer recorded by ${decidedBy}. Use clear_question to remove from queue after implementing.`,
  };
}

function clearQuestion(args: ClearQuestionArgs): ClearQuestionResult | ErrorResult {
  const db = getDb();
  const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(args.id) as QuestionRecord | undefined;

  if (!question) {
    return { error: `Question not found: ${args.id}` };
  }

  const now = new Date();
  const cleared_at = now.toISOString();
  const cleared_timestamp = now.toISOString();

  // Archive the question before deleting
  db.prepare(`
    INSERT INTO cleared_questions (id, type, title, description, recommendation, answer, answered_at, decided_by, cleared_at, cleared_timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    question.id,
    question.type,
    question.title,
    question.description,
    question.recommendation,
    question.answer,
    question.answered_at,
    question.decided_by,
    cleared_at,
    cleared_timestamp
  );

  db.prepare('DELETE FROM questions WHERE id = ?').run(args.id);

  const remainingCount = getPendingCount();

  // Build message with reminder about plan notes
  let message: string;
  if (remainingCount === 0) {
    message = 'Question cleared. No more pending questions - CTO session can end.';
  } else {
    message = `Question cleared. ${remainingCount} question(s) remaining.`;
  }

  // Add reminder about CTO-PENDING notes in plans
  message += `\n\nREMINDER: If this question was linked to a CTO-PENDING note in PLAN.md or /plans, ` +
    `search for "<!-- CTO-PENDING: ${  args.id  }" and remove the marker now that the CTO has responded.`;

  return {
    id: args.id,
    cleared: true,
    message,
    remaining_count: remainingCount,
  };
}

// Token expires after 5 minutes
const TOKEN_EXPIRY_MS = 5 * 60 * 1000;

// Bypass requests expire after 1 hour (stale requests from dead agents)
const BYPASS_REQUEST_TTL_S = 3600;

/**
 * Expire stale bypass-request questions that have been pending beyond the TTL.
 * These are requests from agents that have since terminated without cleanup.
 */
function expireStaleBypassRequests(db: Database.Database): number {
  const cutoff = new Date(Date.now() - BYPASS_REQUEST_TTL_S * 1000).toISOString();
  const result = db.prepare(`
    DELETE FROM questions
    WHERE type = 'bypass-request' AND status = 'pending'
    AND created_timestamp < ?
  `).run(cutoff);
  return result.changes;
}
const APPROVAL_TOKEN_PATH = path.join(PROJECT_DIR, '.claude', 'commit-approval-token.json');

function approveCommit(args: ApproveCommitArgs): ApproveCommitResult {
  const db = getDb();

  // G020: Block commits when ANY pending items exist (questions OR triage)
  const pending = getTotalPendingItems();
  if (pending.total > 0) {
    const blockReasons: string[] = [];
    if (pending.questions > 0) {
      blockReasons.push(`${pending.questions} CTO question(s)`);
    }
    if (pending.triage > 0) {
      blockReasons.push(`${pending.triage} untriaged report(s)`);
    }
    return {
      approved: false,
      decision_id: '',
      message: `Cannot approve commit: ${blockReasons.join(' and ')} must be addressed first.`,
    };
  }

  // G011: Check for an existing recent approved decision with the same rationale before
  // clearing and re-inserting. This makes approve_commit idempotent: repeated calls with
  // the same rationale within 60 seconds return the same decision without deleting and
  // re-creating the approval token file.
  const sixtySecondsAgo = new Date(Date.now() - 60 * 1000).toISOString();
  const existingApproval = db.prepare(`
    SELECT id, created_at FROM commit_decisions
    WHERE decision = 'approved' AND rationale = ? AND created_timestamp >= ?
    ORDER BY created_timestamp DESC LIMIT 1
  `).get(args.rationale, sixtySecondsAgo) as { id: string; created_at: string } | undefined;

  if (existingApproval) {
    const diffHash = process.env['DEPUTY_CTO_DIFF_HASH'] || '';
    return {
      approved: true,
      decision_id: existingApproval.id,
      message: `Commit already approved (deduplicated). Decision ID: ${existingApproval.id}. Retry your commit within 5 minutes.${diffHash ? ` (hash: ${diffHash})` : ''}`,
    };
  }

  // Clear any existing decision
  clearLatestCommitDecision();

  const id = randomUUID();
  const now = new Date();
  const created_at = now.toISOString();
  const created_timestamp = now.toISOString();

  db.prepare(`
    INSERT INTO commit_decisions (id, decision, rationale, created_at, created_timestamp)
    VALUES (?, 'approved', ?, ?, ?)
  `).run(id, args.rationale, created_at, created_timestamp);

  // Write approval token for pre-commit hook
  const diffHash = process.env['DEPUTY_CTO_DIFF_HASH'] || '';
  const token = {
    diffHash,
    expiresAt: Date.now() + TOKEN_EXPIRY_MS,
    approvedAt: created_at,
    approvedBy: 'deputy-cto',
    rationale: args.rationale,
    decisionId: id,
  };

  try {
    fs.writeFileSync(APPROVAL_TOKEN_PATH, JSON.stringify(token, null, 2));
  } catch (err) {
    // G001: Fail-closed - if token file write fails, the approval is non-functional
    // because the pre-commit hook reads the token file, not the database
    console.error(`[deputy-cto] G001: Approval token write failed: ${err}`);
    // Roll back the database decision so state is consistent
    try {
      db.prepare('DELETE FROM commit_decisions WHERE id = ?').run(id);
    } catch (rollbackErr) {
      console.error(`[deputy-cto] G001: Failed to roll back approval decision: ${rollbackErr}`);
    }
    return {
      approved: false,
      decision_id: '',
      message: 'Approval token write failed - check file permissions on commit-approval-token.json. The approval has been rolled back.',
    };
  }

  return {
    approved: true,
    decision_id: id,
    message: `Commit approved. Token written - retry your commit within 5 minutes.${diffHash ? ` (hash: ${diffHash})` : ''}`,
  };
}

function rejectCommit(args: RejectCommitArgs): RejectCommitResult {
  const db = getDb();

  // G011: Check for an existing pending rejection question with the same title before
  // inserting. The unique partial index on (type, title) WHERE status != 'answered'
  // acts as a safety net for race conditions, but this SELECT-first approach preserves
  // the original question's ID and timestamps and avoids crashing on the UNIQUE constraint.
  const existingQuestion = db.prepare(`
    SELECT id FROM questions WHERE type = 'rejection' AND title = ? AND status != 'answered' LIMIT 1
  `).get(args.title) as { id: string } | undefined;

  if (existingQuestion) {
    // Find the associated commit decision (if any) for completeness
    const existingDecision = db.prepare(`
      SELECT id FROM commit_decisions WHERE question_id = ? ORDER BY created_timestamp DESC LIMIT 1
    `).get(existingQuestion.id) as { id: string } | undefined;

    return {
      rejected: true,
      decision_id: existingDecision?.id ?? '',
      question_id: existingQuestion.id,
      message: `Commit rejection already recorded (deduplicated). Question ID: ${existingQuestion.id}. Commits will be blocked until CTO addresses this.`,
    };
  }

  // Clear any existing decision
  clearLatestCommitDecision();

  const decisionId = randomUUID();
  const questionId = randomUUID();
  const now = new Date();
  const created_at = now.toISOString();
  const created_timestamp = now.toISOString();

  // Wrap both INSERTs in a transaction for atomicity: either both records are created
  // or neither is, preventing orphaned commit_decisions or questions records.
  const insertBoth = db.transaction(() => {
    // Create commit decision
    db.prepare(`
      INSERT INTO commit_decisions (id, decision, rationale, question_id, created_at, created_timestamp)
      VALUES (?, 'rejected', ?, ?, ?, ?)
    `).run(decisionId, args.description, questionId, created_at, created_timestamp);

    // Create question entry for CTO to address
    db.prepare(`
      INSERT INTO questions (id, type, status, title, description, created_at, created_timestamp)
      VALUES (?, 'rejection', 'pending', ?, ?, ?, ?)
    `).run(questionId, args.title, args.description, created_at, created_timestamp);
  });

  try {
    insertBoth();
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      (err as Error & { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
    ) {
      // Race condition: another call inserted between our SELECT and INSERT.
      // Re-SELECT to return the winning record.
      const fallback = db.prepare(`
        SELECT id FROM questions WHERE type = 'rejection' AND title = ? AND status != 'answered' LIMIT 1
      `).get(args.title) as { id: string } | undefined;
      if (fallback) {
        const fallbackDecision = db.prepare(`
          SELECT id FROM commit_decisions WHERE question_id = ? ORDER BY created_timestamp DESC LIMIT 1
        `).get(fallback.id) as { id: string } | undefined;
        return {
          rejected: true,
          decision_id: fallbackDecision?.id ?? '',
          question_id: fallback.id,
          message: `Commit rejection already recorded (deduplicated). Question ID: ${fallback.id}. Commits will be blocked until CTO addresses this.`,
        };
      }
    }
    throw err; // Re-throw unexpected errors
  }

  return {
    rejected: true,
    decision_id: decisionId,
    question_id: questionId,
    message: `Commit rejected. Question created for CTO (ID: ${questionId}). Commits will be blocked until CTO addresses this.`,
  };
}

function getCommitDecision(): GetCommitDecisionResult {
  const db = getDb();

  // Get latest commit decision
  const decision = db.prepare(`
    SELECT * FROM commit_decisions ORDER BY created_timestamp DESC LIMIT 1
  `).get() as { id: string; decision: 'approved' | 'rejected'; rationale: string } | undefined;

  const pendingRejections = getPendingRejectionCount();
  const pending = getTotalPendingItems();
  // G020: Block commits when ANY pending items exist (questions OR triage)
  const commitsBlocked = pending.total > 0;

  // Build informative message about what's blocking
  const blockReasons: string[] = [];
  if (pending.questions > 0) {
    blockReasons.push(`${pending.questions} CTO question(s)`);
  }
  if (pending.triage > 0) {
    blockReasons.push(`${pending.triage} untriaged report(s)`);
  }
  const blockMessage = blockReasons.join(' and ');

  if (!decision) {
    return {
      has_decision: false,
      decision: null,
      rationale: null,
      pending_rejections: pendingRejections,
      commits_blocked: commitsBlocked,
      message: commitsBlocked
        ? `No decision yet. ${blockMessage} blocking commits.`
        : 'No decision yet. Awaiting deputy-cto review.',
    };
  }

  return {
    has_decision: true,
    decision: decision.decision,
    rationale: decision.rationale,
    pending_rejections: pendingRejections,
    commits_blocked: commitsBlocked,
    message: commitsBlocked
      ? `Decision: ${decision.decision}, but ${blockMessage} still blocking commits.`
      : `Decision: ${decision.decision}. Commits may proceed.`,
  };
}

function getPendingCountTool(): GetPendingCountResult {
  const pendingCount = getPendingCount();
  const rejectionCount = getPendingRejectionCount();
  const pendingTriage = getPendingTriageCount();

  return {
    pending_count: pendingCount,
    rejection_count: rejectionCount,
    pending_triage_count: pendingTriage,
    // G020: Block commits when ANY pending items exist (questions OR triage)
    commits_blocked: pendingCount > 0 || pendingTriage > 0,
  };
}

// ============================================================================
// Autonomous Mode Functions
// ============================================================================

function getAutonomousConfig(): AutonomousModeConfig {
  const defaults: AutonomousModeConfig = {
    enabled: false,
    claudeMdRefactorEnabled: true,
    lastModified: null,
    modifiedBy: null,
    lastCtoBriefing: null,
  };

  if (!fs.existsSync(AUTONOMOUS_CONFIG_PATH)) {
    return defaults;
  }

  try {
    const config = JSON.parse(fs.readFileSync(AUTONOMOUS_CONFIG_PATH, 'utf8'));
    return { ...defaults, ...config };
  } catch (err) {
    // G001: Config corruption logged but fail-safe to disabled mode
    console.error(`[deputy-cto] Config file corrupted - autonomous mode DISABLED: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`[deputy-cto] Fix: Delete or repair the config file`);
    return defaults;
  }
}

function getNextRunMinutes(): number | null {
  if (!fs.existsSync(AUTOMATION_STATE_PATH)) {
    return 0; // First run would happen immediately
  }

  try {
    const state = JSON.parse(fs.readFileSync(AUTOMATION_STATE_PATH, 'utf8'));
    const lastRun = state.lastRun || 0;
    const now = Date.now();
    const timeSinceLastRun = now - lastRun;
    const cooldownMs = COOLDOWN_MINUTES * 60 * 1000;

    if (timeSinceLastRun >= cooldownMs) {
      return 0; // Would run now if service triggers
    }

    return Math.ceil((cooldownMs - timeSinceLastRun) / 60000);
  } catch (err) {
    // G001: State file corruption - return null to indicate unknown state
    console.error(`[deputy-cto] State file corrupted: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`[deputy-cto] Fix: Delete the state file to reset.`);
    return null;
  }
}

function toggleAutonomousMode(args: ToggleAutonomousModeArgs): ToggleAutonomousModeResult {
  const config = getAutonomousConfig();
  config.enabled = args.enabled;
  config.lastModified = new Date().toISOString();
  config.modifiedBy = 'deputy-cto';

  try {
    fs.writeFileSync(AUTONOMOUS_CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      enabled: !args.enabled, // Return previous state on failure
      message: `Failed to update config: ${message}`,
      nextRunIn: null,
    };
  }

  const nextRunIn = args.enabled ? getNextRunMinutes() : null;

  return {
    enabled: args.enabled,
    message: args.enabled
      ? `Autonomous Deputy CTO Mode ENABLED. Automations will run on their configured schedules.`
      : `Autonomous Deputy CTO Mode DISABLED. No hourly automations will run.`,
    nextRunIn,
  };
}

function getAutonomousModeStatus(): GetAutonomousModeStatusResult {
  const config = getAutonomousConfig();
  const nextRunIn = config.enabled ? getNextRunMinutes() : null;

  // Calculate CTO activity gate status
  let hoursSinceLastBriefing: number | null = null;
  let ctoGateOpen = false;
  if (config.lastCtoBriefing) {
    const briefingTime = new Date(config.lastCtoBriefing).getTime();
    if (!isNaN(briefingTime)) {
      hoursSinceLastBriefing = Math.floor((Date.now() - briefingTime) / (1000 * 60 * 60));
      ctoGateOpen = hoursSinceLastBriefing < 24;
    }
  }

  let message: string;
  if (!config.enabled) {
    message = 'Autonomous Deputy CTO Mode is DISABLED.';
  } else if (!ctoGateOpen) {
    const ageStr = hoursSinceLastBriefing !== null ? `${hoursSinceLastBriefing}h ago` : 'never';
    message = `Autonomous Deputy CTO Mode is ENABLED but CTO activity gate is CLOSED (last briefing: ${ageStr}). Run /deputy-cto to reactivate.`;
  } else if (nextRunIn === null) {
    message = 'Autonomous Deputy CTO Mode is ENABLED. Status unknown (state file error).';
  } else if (nextRunIn === 0) {
    message = 'Autonomous Deputy CTO Mode is ENABLED. Ready to run (waiting for service trigger).';
  } else {
    message = `Autonomous Deputy CTO Mode is ENABLED. Next run in ~${nextRunIn} minute(s).`;
  }

  return {
    enabled: config.enabled,
    claudeMdRefactorEnabled: config.claudeMdRefactorEnabled,
    lastModified: config.lastModified,
    nextRunIn,
    lastCtoBriefing: config.lastCtoBriefing,
    ctoGateOpen,
    hoursSinceLastBriefing,
    message,
  };
}

function recordCtoBriefing(): RecordCtoBriefingResult {
  const config = getAutonomousConfig();
  const now = new Date().toISOString();
  config.lastCtoBriefing = now;
  config.lastModified = now;
  config.modifiedBy = 'deputy-cto';

  try {
    fs.writeFileSync(AUTONOMOUS_CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      recorded: false,
      timestamp: now,
      message: `Failed to record CTO briefing timestamp: ${message}`,
    };
  }

  return {
    recorded: true,
    timestamp: now,
    message: `CTO briefing activity recorded at ${now}. Automation gate refreshed for 24 hours.`,
  };
}

function searchClearedItems(args: SearchClearedItemsArgs): SearchClearedItemsResult {
  const db = getDb();

  const query = `%${args.query}%`;
  const limit = args.limit ?? 10;

  const items = db.prepare(`
    SELECT id, type, title, answer, answered_at, decided_by
    FROM cleared_questions
    WHERE title LIKE ? OR description LIKE ? OR id LIKE ?
    ORDER BY cleared_timestamp DESC
    LIMIT ?
  `).all(query, query, query, limit) as ClearedQuestionItem[];

  return {
    items,
    count: items.length,
    message: items.length === 0
      ? `No cleared items found matching "${args.query}".`
      : `Found ${items.length} cleared item(s) matching "${args.query}".`,
  };
}

// ============================================================================
// Investigation Tools
// ============================================================================

const MAX_CONTEXT_SIZE = 10 * 1024; // 10KB cap

function updateQuestion(args: UpdateQuestionArgs): UpdateQuestionResult | ErrorResult {
  const db = getDb();
  const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(args.id) as QuestionRecord | undefined;

  if (!question) {
    return { error: `Question not found: ${args.id}` };
  }

  if (question.status !== 'pending') {
    return { error: `Cannot update question ${args.id}: status is '${question.status}', expected 'pending'.` };
  }

  // Block updating bypass-request and protected-action-request types
  if (question.type === 'bypass-request' || question.type === 'protected-action-request') {
    return { error: `Cannot update ${question.type} questions via update_question.` };
  }

  const separator = `\n\n--- Investigation Update (${new Date().toISOString()}) ---\n`;
  const existingContext = question.context ?? '';
  const newContext = existingContext + separator + args.append_context;

  if (newContext.length > MAX_CONTEXT_SIZE) {
    return { error: `Context would exceed 10KB limit (current: ${existingContext.length} bytes, appending: ${args.append_context.length + separator.length} bytes).` };
  }

  db.prepare('UPDATE questions SET context = ? WHERE id = ?').run(newContext, args.id);

  return {
    id: args.id,
    updated: true,
    message: `Investigation findings appended to question ${args.id}. Context is now ${newContext.length} bytes.`,
  };
}

function resolveQuestion(args: ResolveQuestionArgs): ResolveQuestionResult | ErrorResult {
  const db = getDb();
  const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(args.id) as QuestionRecord | undefined;

  if (!question) {
    return { error: `Question not found: ${args.id}` };
  }

  if (question.status === 'answered') {
    return { error: `Question ${args.id} is already answered. Cannot resolve an already-answered question.` };
  }

  // Block resolving bypass-request and protected-action-request types
  if (question.type === 'bypass-request' || question.type === 'protected-action-request') {
    return { error: `Cannot resolve ${question.type} questions via resolve_question.` };
  }

  const now = new Date();
  const answered_at = now.toISOString();
  const cleared_timestamp = now.toISOString();
  const answer = `[Resolved by investigation: ${args.resolution}]\n${args.resolution_detail}`;

  // Single transaction: answer, archive, delete
  const txn = db.transaction(() => {
    // Mark as answered
    db.prepare(`
      UPDATE questions SET status = 'answered', answer = ?, answered_at = ?, decided_by = 'deputy-cto'
      WHERE id = ?
    `).run(answer, answered_at, args.id);

    // Archive to cleared_questions
    db.prepare(`
      INSERT INTO cleared_questions (id, type, title, description, recommendation, answer, answered_at, decided_by, cleared_at, cleared_timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'deputy-cto', ?, ?)
    `).run(
      question.id,
      question.type,
      question.title,
      question.description,
      question.recommendation,
      answer,
      answered_at,
      answered_at,
      cleared_timestamp
    );

    // Remove from active questions
    db.prepare('DELETE FROM questions WHERE id = ?').run(args.id);
  });

  txn();

  const remainingCount = getPendingCount();

  return {
    id: args.id,
    resolved: true,
    resolution: args.resolution,
    remaining_pending_count: remainingCount,
    message: `Question ${args.id} resolved as '${args.resolution}' by investigation. ${remainingCount} pending question(s) remaining.`,
  };
}

// ============================================================================
// Data Cleanup Functions
// ============================================================================

/**
 * Internal cleanup function that accepts a database parameter.
 * Used during initialization when db is not yet stored in _db.
 *
 * Retention Policy:
 * - Keep last 100 commit decisions
 * - Keep cleared questions for 30 days
 * - Keep at least 500 most recent cleared questions (even if < 30 days old)
 * - Delete spawned_tasks older than 7 days (regardless of status)
 */
function cleanupOldRecordsInternal(db: Database.Database): CleanupOldRecordsResult {
  // Expire stale bypass-request questions (dead agent cleanup)
  const bypassExpired = expireStaleBypassRequests(db);

  // Clean commit_decisions: keep only last 100
  const commitDecisionsResult = db.prepare(`
    DELETE FROM commit_decisions WHERE id NOT IN (
      SELECT id FROM commit_decisions ORDER BY created_timestamp DESC LIMIT 100
    )
  `).run();

  // Clean cleared_questions: keep last 500 OR anything within 30 days
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const clearedQuestionsResult = db.prepare(`
    DELETE FROM cleared_questions
    WHERE cleared_timestamp < ?
    AND id NOT IN (
      SELECT id FROM cleared_questions ORDER BY cleared_timestamp DESC LIMIT 500
    )
  `).run(thirtyDaysAgo);

  // Clean spawned_tasks: remove entries older than 7 days (prevents dedup table from growing unboundedly)
  const spawnedTasksResult = db.prepare(
    `DELETE FROM spawned_tasks WHERE created_at < datetime('now', '-7 days')`
  ).run();

  const commitDeleted = commitDecisionsResult.changes;
  const clearedDeleted = clearedQuestionsResult.changes;
  const spawnedTasksDeleted = spawnedTasksResult.changes;
  const totalDeleted = commitDeleted + clearedDeleted + spawnedTasksDeleted + bypassExpired;

  let message: string;
  if (totalDeleted === 0) {
    message = 'No old records found to clean up. Database is within retention limits.';
  } else {
    const parts: string[] = [];
    if (commitDeleted > 0) {parts.push(`${commitDeleted} commit decision(s)`);}
    if (clearedDeleted > 0) {parts.push(`${clearedDeleted} cleared question(s)`);}
    if (spawnedTasksDeleted > 0) {parts.push(`${spawnedTasksDeleted} spawned task(s)`);}
    if (bypassExpired > 0) {parts.push(`${bypassExpired} stale bypass request(s)`);}
    message = `Cleaned up ${totalDeleted} old record(s): ${parts.join(', ')}.`;
  }

  return {
    commit_decisions_deleted: commitDeleted,
    cleared_questions_deleted: clearedDeleted,
    spawned_tasks_deleted: spawnedTasksDeleted,
    bypass_requests_expired: bypassExpired,
    message,
  };
}

/**
 * Public cleanup function for MCP tool.
 * Cleans up old records to prevent unbounded database growth.
 *
 * This function is idempotent and safe to call multiple times.
 * Automatically called on server startup.
 */
function cleanupOldRecords(): CleanupOldRecordsResult {
  const db = getDb();
  return cleanupOldRecordsInternal(db);
}

// ============================================================================
// Automation Mode Functions
// ============================================================================

const AUTOMATION_DEFAULTS: Record<string, number> = {
  hourly_tasks: 55, triage_check: 5, antipattern_hunter: 360,
  schema_mapper: 1440, lint_checker: 30, todo_maintenance: 15,
  task_runner: 60, triage_per_item: 60, preview_promotion: 360,
  staging_promotion: 1200, staging_health_monitor: 180,
  production_health_monitor: 60, standalone_antipattern_hunter: 180,
  standalone_compliance_checker: 60, user_feedback: 120,
};

interface AutomationConfig {
  version: number;
  defaults: Record<string, number>;
  effective: Record<string, number>;
  adjustment: { factor: number; last_updated: string | null; [key: string]: unknown };
  modes?: Record<string, AutomationModeEntry>;
}

function readAutomationConfig(): AutomationConfig {
  const defaults: AutomationConfig = {
    version: 1,
    defaults: { ...AUTOMATION_DEFAULTS },
    effective: { ...AUTOMATION_DEFAULTS },
    adjustment: { factor: 1.0, last_updated: null },
  };

  if (!fs.existsSync(AUTOMATION_CONFIG_PATH)) return defaults;

  try {
    const config = JSON.parse(fs.readFileSync(AUTOMATION_CONFIG_PATH, 'utf8')) as AutomationConfig;
    if (!config || config.version !== 1) return defaults;
    return config;
  } catch {
    return defaults;
  }
}

function writeAutomationConfig(config: AutomationConfig): void {
  const dir = path.dirname(AUTOMATION_CONFIG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(AUTOMATION_CONFIG_PATH, JSON.stringify(config, null, 2));
}

function setAutomationMode(args: SetAutomationModeArgs): SetAutomationModeResult | ErrorResult {
  const key = args.automation_name;

  // Validate the automation name exists
  if (!AUTOMATION_DEFAULTS[key]) {
    const validKeys = Object.keys(AUTOMATION_DEFAULTS).join(', ');
    return { error: `Unknown automation: "${key}". Valid names: ${validKeys}` };
  }

  if (args.mode === 'static' && args.static_minutes == null) {
    return { error: 'static_minutes is required when mode is "static".' };
  }

  const config = readAutomationConfig();

  // Initialize modes if not present
  if (!config.modes) config.modes = {};

  const entry: AutomationModeEntry = {
    mode: args.mode,
    set_at: new Date().toISOString(),
  };

  if (args.mode === 'static' && args.static_minutes != null) {
    entry.static_minutes = args.static_minutes;
    // Also set the effective cooldown immediately
    if (!config.effective) config.effective = { ...config.defaults };
    config.effective[key] = args.static_minutes;
  } else {
    // Switching back to load_balanced: reset effective to what the optimizer would set
    const factor = config.adjustment?.factor ?? 1.0;
    const defaultVal = config.defaults?.[key] ?? AUTOMATION_DEFAULTS[key];
    if (!config.effective) config.effective = { ...config.defaults };
    config.effective[key] = Math.max(5, Math.round(defaultVal / factor));
  }

  config.modes[key] = entry;

  try {
    writeAutomationConfig(config);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to write config: ${message}` };
  }

  const effectiveMinutes = config.effective[key];

  return {
    automation_name: key,
    mode: args.mode,
    effective_minutes: effectiveMinutes,
    message: args.mode === 'static'
      ? `Set ${key} to static mode: runs every ${args.static_minutes}m (fixed, optimizer will not adjust).`
      : `Set ${key} to load_balanced mode: currently ${effectiveMinutes}m (optimizer will adjust dynamically).`,
  };
}

function listAutomationConfig(): ListAutomationConfigResult {
  const config = readAutomationConfig();
  const automations: AutomationConfigItem[] = [];

  const allKeys = new Set([
    ...Object.keys(AUTOMATION_DEFAULTS),
    ...Object.keys(config.defaults || {}),
    ...Object.keys(config.effective || {}),
  ]);

  for (const key of allKeys) {
    const defaultMinutes = config.defaults?.[key] ?? AUTOMATION_DEFAULTS[key] ?? 0;
    const effectiveMinutes = config.effective?.[key] ?? defaultMinutes;
    const modeEntry = config.modes?.[key];
    const mode = modeEntry?.mode ?? 'load_balanced';
    const staticMinutes = modeEntry?.static_minutes ?? null;

    automations.push({
      name: key,
      mode,
      default_minutes: defaultMinutes,
      effective_minutes: effectiveMinutes,
      static_minutes: staticMinutes,
    });
  }

  // Sort by name
  automations.sort((a, b) => a.name.localeCompare(b.name));

  return {
    automations,
    factor: config.adjustment?.factor ?? 1.0,
    last_updated: config.adjustment?.last_updated ?? null,
    message: `${automations.length} automation(s) configured. Factor: ${(config.adjustment?.factor ?? 1.0).toFixed(3)}.`,
  };
}

// ============================================================================
// Preview Promotion
// ============================================================================

async function triggerPreviewPromotion(args: TriggerPreviewPromotionArgs): Promise<TriggerPreviewPromotionResult | ErrorResult> {
  // 1. Check branches exist
  try {
    execSync('git rev-parse --verify origin/preview', { cwd: PROJECT_DIR, encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
    execSync('git rev-parse --verify origin/staging', { cwd: PROJECT_DIR, encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
  } catch {
    return { error: 'Preview or staging branch not found. Both must exist for promotion.' };
  }

  // 3. Check for commits to promote
  let commits: string[];
  try {
    const output = execSync('git log --oneline origin/staging..origin/preview', {
      cwd: PROJECT_DIR, encoding: 'utf8', timeout: 10000, stdio: 'pipe',
    }).trim();
    if (!output) {
      return { error: 'Preview and staging are in sync. Nothing to promote.' };
    }
    commits = output.split('\n');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to check preview-staging drift: ${message}` };
  }

  // 4. Spawn preview-promoter via session queue
  try {
    const { enqueueSession } = await import(path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'session-queue.js'));

    let currentSha: string;
    try {
      currentSha = execSync('git rev-parse origin/preview', {
        cwd: PROJECT_DIR, encoding: 'utf8', timeout: 5000, stdio: 'pipe',
      }).trim();
    } catch {
      currentSha = Date.now().toString(16);
    }

    const promotionId = args.promotion_id || `prom-${Date.now()}-${currentSha.slice(0, 8)}`;
    const commitList = commits.join('\n');

    // Create promotion worktree (same pattern as hourly-automation.js)
    let cwd = PROJECT_DIR;
    let mcpConfig = path.join(PROJECT_DIR, '.mcp.json');
    try {
      const { createWorktree } = await import(path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'worktree-manager.js'));
      const branchName = 'automation/preview-promotion';
      const worktree = createWorktree(branchName, 'preview');
      if (worktree.created) {
        cwd = worktree.path;
      } else {
        cwd = worktree.path;
        try {
          execSync('git pull --ff-only', { cwd: worktree.path, encoding: 'utf8', timeout: 30000, stdio: 'pipe' });
        } catch { /* non-fatal */ }
      }
      mcpConfig = path.join(cwd, '.mcp.json');
    } catch {
      // Fall back to PROJECT_DIR (same as hourly-automation)
    }

    const result = enqueueSession({
      title: `[Preview → Staging] ${commits.length} commits`,
      agentType: 'preview-promoter',
      hookType: 'hourly-automation',
      tagContext: 'preview-promotion',
      source: 'deputy-cto-server',
      priority: 'urgent',
      agent: 'preview-promoter',
      buildPrompt: (agentId: string) => [
        `[Automation][preview-promoter][AGENT:${agentId}]`,
        `## Preview → Staging Promotion`,
        ``,
        `**Promotion ID**: ${promotionId}`,
        `**Commits to promote** (${commits.length}):`,
        '```',
        commitList,
        '```',
        ``,
        `Follow your agent instructions to evaluate quality, run tests/demos,`,
        `and promote if all gates pass.`,
        ``,
        `Artifact directory: .claude/promotions/${promotionId}/`,
      ].join('\n'),
      extraEnv: {
        CLAUDE_PROJECT_DIR: PROJECT_DIR,
        GENTYR_PROMOTION_ID: promotionId,
        GENTYR_PROMOTION_PIPELINE: 'true',
      },
      metadata: {
        promotionId,
        commitCount: commits.length,
        previewSha: currentSha,
      },
      cwd,
      mcpConfig,
      projectDir: PROJECT_DIR,
    });

    return {
      queueId: result.queueId,
      promotionId,
      commitCount: commits.length,
      commits,
      message: `Preview-promoter enqueued (queue ID: ${result.queueId}). ${commits.length} commits will be evaluated through the full quality pipeline (migration safety, tests, coverage, demos) before promotion.`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to enqueue preview-promoter: ${message}` };
  }
}

// ============================================================================
// Merge Chain Status
// ============================================================================

async function getMergeChainStatus(_args: GetMergeChainStatusArgs): Promise<string> {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const gitOpts = { cwd: projectDir, encoding: 'utf8' as const, timeout: 15000, stdio: 'pipe' as const };

  const result: Record<string, unknown> = {};

  // Fetch latest
  try {
    execSync('git fetch origin --quiet 2>/dev/null || true', gitOpts);
  } catch { /* non-fatal */ }

  // Preview ahead of staging
  try {
    const log = execSync('git log origin/staging..origin/preview --oneline', gitOpts).trim();
    const commits = log ? log.split('\n') : [];
    result.previewAheadOfStaging = commits.length;
  } catch {
    result.previewAheadOfStaging = 'unknown (branch may not exist)';
  }

  // Staging ahead of main
  try {
    const log = execSync('git log origin/main..origin/staging --oneline', gitOpts).trim();
    const commits = log ? log.split('\n') : [];
    result.stagingAheadOfMain = commits.length;
  } catch {
    result.stagingAheadOfMain = 'unknown (branch may not exist)';
  }

  // Active feature branches
  try {
    const branches = execSync('git branch -r --list "origin/feature/*"', gitOpts).trim();
    const branchList = branches ? branches.split('\n').map((b: string) => b.trim().replace('origin/', '')) : [];
    result.activeFeatureBranches = branchList.length;
    result.featureBranchNames = branchList;
  } catch {
    result.activeFeatureBranches = 0;
    result.featureBranchNames = [];
  }

  // Stale branches (>3 days old with no recent commits)
  try {
    const branches = (result.featureBranchNames as string[]) || [];
    const staleBranches: string[] = [];
    const threeDaysAgo = Math.floor(Date.now() / 1000) - (3 * 86400);

    for (const branch of branches) {
      try {
        const timestamp = parseInt(execSync(`git log -1 --format=%ct origin/${branch}`, gitOpts).trim(), 10);
        if (timestamp < threeDaysAgo) {
          staleBranches.push(branch);
        }
      } catch { /* skip */ }
    }
    result.staleBranches = staleBranches.length;
    result.staleBranchNames = staleBranches;
  } catch {
    result.staleBranches = 0;
    result.staleBranchNames = [];
  }

  // Uncommitted changes
  try {
    const status = execSync('git status --porcelain', gitOpts).trim();
    result.uncommittedChanges = status ? status.split('\n').length : 0;
  } catch {
    result.uncommittedChanges = 'unknown';
  }

  // Last promotion timestamps
  try {
    const previewTs = execSync('git log -1 --format=%ct origin/preview', gitOpts).trim();
    const hoursSince = Math.floor((Date.now() / 1000 - parseInt(previewTs, 10)) / 3600);
    result.lastPreviewCommitHoursAgo = hoursSince;
  } catch {
    result.lastPreviewCommitHoursAgo = 'unknown';
  }

  try {
    const stagingTs = execSync('git log -1 --format=%ct origin/staging', gitOpts).trim();
    const hoursSince = Math.floor((Date.now() / 1000 - parseInt(stagingTs, 10)) / 3600);
    result.lastStagingCommitHoursAgo = hoursSince;
  } catch {
    result.lastStagingCommitHoursAgo = 'unknown';
  }

  return JSON.stringify(result, null, 2);
}

// ============================================================================
// Server Setup
// ============================================================================

const tools: AnyToolHandler[] = [
  {
    name: 'add_question',
    description: 'Add a question/decision request for the CTO. Use for decisions, approvals, or escalations from reports. Escalations REQUIRE a recommendation field.',
    schema: AddQuestionArgsSchema,
    handler: addQuestion,
  },
  {
    name: 'list_questions',
    description: 'List CTO questions (titles only to preserve tokens). Shows pending count and whether commits are blocked.',
    schema: ListQuestionsArgsSchema,
    handler: listQuestions,
  },
  {
    name: 'read_question',
    description: 'Read the full content of a question including description and context.',
    schema: ReadQuestionArgsSchema,
    handler: readQuestion,
  },
  {
    name: 'answer_question',
    description: 'Record the CTO answer to a question. Question remains in queue until cleared.',
    schema: AnswerQuestionArgsSchema,
    handler: answerQuestion,
  },
  {
    name: 'clear_question',
    description: 'Remove a question from the queue after it has been addressed/implemented.',
    schema: ClearQuestionArgsSchema,
    handler: clearQuestion,
  },
  {
    name: 'approve_commit',
    description: 'Approve the pending commit. Cannot approve if there are pending rejections.',
    schema: ApproveCommitArgsSchema,
    handler: approveCommit,
  },
  {
    name: 'reject_commit',
    description: 'Reject the pending commit. Creates a question entry that blocks future commits until addressed.',
    schema: RejectCommitArgsSchema,
    handler: rejectCommit,
  },
  {
    name: 'get_commit_decision',
    description: 'Get the current commit decision status. Used by pre-commit hook to allow/block commits.',
    schema: GetCommitDecisionArgsSchema,
    handler: getCommitDecision,
  },
  {
    name: 'get_pending_count',
    description: 'Get count of pending questions and whether commits are blocked. Used by session hooks.',
    schema: GetPendingCountArgsSchema,
    handler: getPendingCountTool,
  },
  {
    name: 'toggle_autonomous_mode',
    description: 'Enable or disable Autonomous Deputy CTO Mode. When enabled, hourly plan execution and CLAUDE.md refactoring runs.',
    schema: ToggleAutonomousModeArgsSchema,
    handler: toggleAutonomousMode,
  },
  {
    name: 'get_autonomous_mode_status',
    description: 'Get the current status of Autonomous Deputy CTO Mode, including when next run will occur and CTO activity gate status.',
    schema: GetAutonomousModeStatusArgsSchema,
    handler: getAutonomousModeStatus,
  },
  {
    name: 'record_cto_briefing',
    description: 'Record that the CTO has started a briefing session. Refreshes the 24-hour automation activity gate. Must be called at the start of every /deputy-cto session.',
    schema: RecordCtoBriefingArgsSchema,
    handler: recordCtoBriefing,
  },
  {
    name: 'search_cleared_items',
    description: 'Search previously cleared CTO questions by substring. Use to check if a CTO-PENDING note in a plan has been addressed.',
    schema: SearchClearedItemsArgsSchema,
    handler: searchClearedItems,
  },
  {
    name: 'update_question',
    description: 'Append investigation findings to a pending question\'s context field. Append-only with timestamped separators. 10KB context cap. Only works on pending questions (not bypass-request or protected-action-request).',
    schema: UpdateQuestionArgsSchema,
    handler: updateQuestion,
  },
  {
    name: 'resolve_question',
    description: 'Resolve a pending escalation based on investigation findings. Answers, archives to cleared_questions, and removes from active queue in a single transaction. CTO never sees it. Only works on pending questions (not bypass-request or protected-action-request).',
    schema: ResolveQuestionArgsSchema,
    handler: resolveQuestion,
  },
  {
    name: 'cleanup_old_records',
    description: 'Clean up old records to prevent unbounded database growth. Retains last 100 commit decisions and cleared questions within 30 days (minimum 500). Automatically runs on startup.',
    schema: CleanupOldRecordsArgsSchema,
    handler: cleanupOldRecords,
  },
  // Automation mode tools
  {
    name: 'set_automation_mode',
    description: 'ALWAYS use this tool (not manual file edits) to change automation frequency, interval, or schedule. Sets an automation to load_balanced (dynamic) or static (fixed interval) mode. Call list_automation_config first to see current values.',
    schema: SetAutomationModeArgsSchema,
    handler: setAutomationMode,
  },
  {
    name: 'list_automation_config',
    description: 'ALWAYS use this tool (not manual file reads) to view automation frequencies, intervals, schedules, or cooldowns. Lists all automations with their mode, effective intervals, and static overrides.',
    schema: ListAutomationConfigArgsSchema,
    handler: listAutomationConfig,
  },
  {
    name: 'get_merge_chain_status',
    description: 'Get the current merge chain status: branch positions, active/stale feature branches, uncommitted changes. Used for CTO briefing. Production releases are now CTO-initiated via /promote-to-prod (automated promotion pipeline removed).',
    schema: GetMergeChainStatusArgsSchema,
    handler: getMergeChainStatus,
  },
  {
    name: 'trigger_preview_promotion',
    description: 'Trigger a preview → staging promotion. Spawns the preview-promoter agent with full quality gates (migration safety, tests, coverage, related demos). This is the ONLY correct way to manually trigger promotion — do NOT use create_task for staging promotion.',
    schema: TriggerPreviewPromotionArgsSchema,
    handler: triggerPreviewPromotion,
  },
];

const server = new McpServer({
  name: 'deputy-cto',
  version: '1.0.0',
  tools,
});

// Handle cleanup on exit
process.on('SIGINT', () => {
  closeDb();
  process.exit(0);
});

process.on('SIGTERM', () => {
  closeDb();
  process.exit(0);
});

server.start();
