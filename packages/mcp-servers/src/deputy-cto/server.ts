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
import { spawn, execSync } from 'child_process';

const { randomUUID, createHash } = crypto;
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
  RequestBypassArgsSchema,
  ExecuteBypassArgsSchema,
  ListProtectionsArgsSchema,
  GetProtectedActionRequestArgsSchema,
  ApproveProtectedActionArgsSchema,
  DenyProtectedActionArgsSchema,
  ListPendingActionRequestsArgsSchema,
  RequestPreapprovedBypassArgsSchema,
  ActivatePreapprovedBypassArgsSchema,
  ListPreapprovedBypassesArgsSchema,
  ReviewBlockingItemsArgsSchema,
  CreatePromotionBypassArgsSchema,
  GetMergeChainStatusArgsSchema,
  RequestHotfixPromotionArgsSchema,
  ExecuteHotfixPromotionArgsSchema,
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
  type RequestBypassArgs,
  type ExecuteBypassArgs,
  type GetProtectedActionRequestArgs,
  type ApproveProtectedActionArgs,
  type DenyProtectedActionArgs,
  type RequestPreapprovedBypassArgs,
  type ActivatePreapprovedBypassArgs,
  type ListPreapprovedBypassesArgs,
  type ReviewBlockingItemsArgs,
  type CreatePromotionBypassArgs,
  type GetMergeChainStatusArgs,
  type RequestHotfixPromotionArgs,
  type ExecuteHotfixPromotionArgs,
  type RequestHotfixPromotionResult,
  type ExecuteHotfixPromotionResult,
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
  type RequestBypassResult,
  type ExecuteBypassResult,
  type ListProtectionsResult,
  type GetProtectedActionRequestResult,
  type ApproveProtectedActionResult,
  type DenyProtectedActionResult,
  type PendingActionRequestItem,
  type ListPendingActionRequestsResult,
  type RequestPreapprovedBypassResult,
  type ActivatePreapprovedBypassResult,
  type PreapprovedBypassItem,
  type ListPreapprovedBypassesResult,
  type ReviewBlockingItemsResult,
  type BlockingItemSummary,
  type CreatePromotionBypassResult,
  type ClearedQuestionItem,
  type AutonomousModeConfig,
  type ErrorResult,
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
const PROTECTED_ACTIONS_PATH = path.join(PROJECT_DIR, '.claude', 'hooks', 'protected-actions.json');
const PROTECTED_APPROVALS_PATH = path.join(PROJECT_DIR, '.claude', 'protected-action-approvals.json');
const APPROVALS_LOCK_PATH = PROTECTED_APPROVALS_PATH + '.lock';
const PROTECTION_KEY_PATH = path.join(PROJECT_DIR, '.claude', 'protection-key');
const HOTFIX_APPROVAL_TOKEN_PATH = path.join(PROJECT_DIR, '.claude', 'hotfix-approval-token.json');
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

CREATE TABLE IF NOT EXISTS hotfix_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL,
    commits_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    CONSTRAINT valid_hotfix_status CHECK (status IN ('pending', 'approved', 'executed', 'expired'))
);

CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status);
CREATE INDEX IF NOT EXISTS idx_cleared_questions_cleared ON cleared_questions(cleared_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_questions_type ON questions(type);
CREATE INDEX IF NOT EXISTS idx_commit_decisions_created ON commit_decisions(created_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_hotfix_requests_code ON hotfix_requests(code);

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
  if (question.type === 'bypass-request') {
    return { error: 'Cannot answer bypass-request questions via answer_question. The CTO must type "APPROVE BYPASS <code>" in chat.' };
  }
  if (question.type === 'protected-action-request') {
    return { error: 'Cannot answer protected-action-request questions via answer_question. Use approve_protected_action or deny_protected_action.' };
  }

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

  // Block clearing pending bypass-request and protected-action-request questions
  if (question.type === 'bypass-request' && question.status === 'pending') {
    return { error: 'Cannot clear a pending bypass-request. The CTO must type "APPROVE BYPASS <code>". Only answered bypass-requests can be cleared.' };
  }
  if (question.type === 'protected-action-request' && question.status === 'pending') {
    return { error: 'Cannot clear a pending protected-action-request. Use approve_protected_action or deny_protected_action.' };
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

  // Reject rationales starting with "EMERGENCY BYPASS" — only execute_bypass may use this prefix
  if (/^EMERGENCY\s+BYPASS/i.test(args.rationale)) {
    return {
      approved: false,
      decision_id: '',
      message: 'Cannot use "EMERGENCY BYPASS" prefix in approve_commit rationale. Use request_bypass for emergency bypass requests.',
    };
  }

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
// Bypass Governance Functions
// ============================================================================

/**
 * Request a bypass from the CTO.
 *
 * This creates a bypass-request question in the CTO queue. The requesting agent
 * should STOP attempting commits and wait for CTO review via /deputy-cto session.
 *
 * IMPORTANT: Agents cannot use SKIP_DEPUTY_CTO_REVIEW directly. They must
 * request approval through this tool, and only the Deputy CTO (in /deputy-cto session)
 * can execute the bypass after CTO approval.
 */
/**
 * Generate a 6-character alphanumeric bypass code
 */
function generateBypassCode(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // Exclude confusing chars: 0/O, 1/I/L
  let code = '';
  const randomBytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(randomBytes[i] % chars.length);
  }
  return code;
}

function requestBypass(args: RequestBypassArgs): RequestBypassResult {
  const db = getDb();

  // Self-clean stale bypass requests before rate-limit check
  expireStaleBypassRequests(db);

  // G011: Use a deterministic title keyed by agent so duplicate calls are idempotent.
  // The unique index on (type, title) WHERE status != 'answered' acts as a safety net for race
  // conditions, but this SELECT-first approach preserves the original request's ID and bypass code.
  const title = `Bypass Request [${args.reporting_agent}]`;
  const existingBypass = db.prepare(`
    SELECT id, context FROM questions
    WHERE type = 'bypass-request' AND title = ? AND status = 'pending' LIMIT 1
  `).get(title) as { id: string; context: string } | undefined;

  if (existingBypass) {
    const existingCode = existingBypass.context;
    return {
      request_id: existingBypass.id,
      bypass_code: existingCode,
      message: `Bypass request already pending (deduplicated). To approve, the CTO must type: APPROVE BYPASS ${existingCode}`,
      instructions: `STOP attempting commits. Ask the CTO to type exactly: APPROVE BYPASS ${existingCode}`,
    };
  }

  // Rate limit: max 3 pending bypass requests at a time
  const pendingBypasses = db.prepare(
    "SELECT COUNT(*) as count FROM questions WHERE type = 'bypass-request' AND status = 'pending'"
  ).get() as { count: number };
  if (pendingBypasses.count >= 3) {
    return {
      request_id: '',
      bypass_code: '',
      message: 'Too many pending bypass requests (max 3). Wait for existing requests to be addressed before submitting more.',
      instructions: 'Wait for the CTO to address existing bypass requests.',
    };
  }

  const id = randomUUID();
  const bypassCode = generateBypassCode();
  const now = new Date();
  const created_at = now.toISOString();
  const created_timestamp = now.toISOString();

  const description = `**Bypass requested by:** ${args.reporting_agent}

**Reason:** ${args.reason}

${args.blocked_by ? `**Blocked by:** ${args.blocked_by}` : ''}

---

**CTO Action Required:**
To approve: **APPROVE BYPASS ${bypassCode}**
To deny: **DENY BYPASS ${bypassCode}**

Approving creates an approval token that allows the agent to execute the bypass.
Denying removes the request from the queue.`;

  // Store bypass code in context field for validation
  try {
    db.prepare(`
      INSERT INTO questions (id, type, status, title, description, context, created_at, created_timestamp)
      VALUES (?, 'bypass-request', 'pending', ?, ?, ?, ?, ?)
    `).run(id, title, description, bypassCode, created_at, created_timestamp);
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      (err as Error & { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
    ) {
      // Race condition: another call inserted between our SELECT and INSERT.
      // Re-SELECT to return the winning record.
      const fallback = db.prepare(`
        SELECT id, context FROM questions
        WHERE type = 'bypass-request' AND title = ? AND status = 'pending' LIMIT 1
      `).get(title) as { id: string; context: string } | undefined;
      if (fallback) {
        const fallbackCode = fallback.context;
        return {
          request_id: fallback.id,
          bypass_code: fallbackCode,
          message: `Bypass request already pending (deduplicated). To approve, the CTO must type: APPROVE BYPASS ${fallbackCode}`,
          instructions: `STOP attempting commits. Ask the CTO to type exactly: APPROVE BYPASS ${fallbackCode}`,
        };
      }
    }
    throw err; // Re-throw unexpected errors
  }

  return {
    request_id: id,
    bypass_code: bypassCode,
    message: `Bypass request submitted. To approve, the CTO must type: APPROVE BYPASS ${bypassCode}`,
    instructions: `STOP attempting commits. Ask the CTO to type exactly: APPROVE BYPASS ${bypassCode}`,
  };
}

/**
 * Execute an approved bypass.
 *
 * This verifies that the CTO has typed "APPROVE BYPASS <code>" by checking
 * for an approval token created by the UserPromptSubmit hook.
 *
 * The agent cannot forge this token because:
 * 1. UserPromptSubmit hooks only trigger on actual user input
 * 2. The hook validates the code exists in pending bypass requests
 * 3. The token is tied to the specific bypass code
 */
function executeBypass(args: ExecuteBypassArgs): ExecuteBypassResult | ErrorResult {
  const db = getDb();
  const code = args.bypass_code.toUpperCase();
  const approvalTokenPath = path.join(PROJECT_DIR, '.claude', 'bypass-approval-token.json');

  // Step 1: Verify the bypass request exists with this code
  const question = db.prepare(`
    SELECT id, title FROM questions
    WHERE type = 'bypass-request'
    AND status = 'pending'
    AND context = ?
  `).get(code) as { id: string; title: string } | undefined;

  if (!question) {
    return { error: `No pending bypass request found with code: ${code}` };
  }

  // Step 2: Check for approval token (created by UserPromptSubmit hook when CTO types approval)
  if (!fs.existsSync(approvalTokenPath)) {
    return {
      error: `No approval token found. The CTO must type "APPROVE BYPASS ${code}" to create an approval token.`,
    };
  }

  // Step 3: Verify the approval token
  let token: {
    code: string;
    request_id: string;
    user_message: string;
    expires_timestamp: number;
    hmac?: string;
  };

  try {
    token = JSON.parse(fs.readFileSync(approvalTokenPath, 'utf8'));
  } catch {
    return { error: 'Failed to read approval token. Ask the CTO to type the approval again.' };
  }

  // Empty object means token was consumed (overwrite pattern for sticky-bit compat)
  if (!token.code && !token.request_id && !token.expires_timestamp) {
    return {
      error: `No approval token found. The CTO must type "APPROVE BYPASS ${code}" to create an approval token.`,
    };
  }

  // Verify HMAC signature to prevent agent forgery
  const key = loadProtectionKey();
  if (!key) {
    return { error: 'Protection key missing. Cannot verify bypass approval token. Restore .claude/protection-key.' };
  }
  const expectedHmac = computeHmac(key, token.code, token.request_id, String(token.expires_timestamp), 'bypass-approved');
  if (token.hmac !== expectedHmac) {
    try { fs.writeFileSync(approvalTokenPath, '{}'); } catch { /* ignore */ }
    return { error: 'FORGERY DETECTED: Invalid bypass approval token signature. Token deleted.' };
  }

  // Verify code matches
  if (token.code !== code) {
    return {
      error: `Approval token is for a different bypass code (${token.code}). Ask the CTO to type "APPROVE BYPASS ${code}"`,
    };
  }

  // Verify not expired
  if (Date.now() > token.expires_timestamp) {
    // Clean up expired token (overwrite for sticky-bit compat)
    try { fs.writeFileSync(approvalTokenPath, '{}'); } catch { /* ignore */ }
    return {
      error: `Approval token has expired. Ask the CTO to type "APPROVE BYPASS ${code}" again.`,
    };
  }

  // Step 4: Approval verified - record the bypass and clean up
  const bypassId = randomUUID();
  const now = new Date();
  const created_at = now.toISOString();
  const created_timestamp = now.toISOString();

  // Create an approval record that the pre-commit hook can check
  db.prepare(`
    INSERT INTO commit_decisions (id, decision, rationale, question_id, created_at, created_timestamp)
    VALUES (?, 'approved', ?, ?, ?, ?)
  `).run(bypassId, `EMERGENCY BYPASS - CTO typed "APPROVE BYPASS ${code}"`, question.id, created_at, created_timestamp);

  // Clear the bypass request from the queue
  db.prepare('DELETE FROM questions WHERE id = ?').run(question.id);

  // Clear the approval token (one-time use, overwrite for sticky-bit compat)
  try { fs.writeFileSync(approvalTokenPath, '{}'); } catch { /* ignore */ }

  return {
    executed: true,
    message: `Bypass executed (Decision ID: ${bypassId}). The next commit will proceed without deputy-cto review. This is a ONE-TIME bypass.`,
  };
}

// ============================================================================
// Protected Action Functions
// ============================================================================

interface ProtectedActionsConfig {
  version: string;
  servers: Record<string, {
    protection: string;
    phrase: string;
    tools: string | string[];
    credentialKeys?: string[];
    description?: string;
  }>;
  files?: Record<string, {
    protection: string;
    phrase: string;
    description?: string;
  }>;
  settings?: {
    codeLength?: number;
    expiryMinutes?: number;
    notifyOnBlock?: boolean;
  };
}

interface ApprovalRequest {
  server: string;
  tool: string;
  args: Record<string, unknown>;
  argsHash?: string;
  phrase: string;
  code: string;
  status: 'pending' | 'approved';
  created_at: string;
  created_timestamp: number;
  expires_at: string;
  expires_timestamp: number;
  approved_at?: string;
  approved_timestamp?: number;
}

/**
 * List all protected MCP actions and their configuration
 */
function listProtections(): ListProtectionsResult {
  try {
    if (!fs.existsSync(PROTECTED_ACTIONS_PATH)) {
      return {
        protections: [],
        count: 0,
        message: 'No protected actions configured. Use setup.sh --protect-mcp to configure.',
      };
    }

    const config: ProtectedActionsConfig = JSON.parse(fs.readFileSync(PROTECTED_ACTIONS_PATH, 'utf8'));

    if (!config.servers || Object.keys(config.servers).length === 0) {
      return {
        protections: [],
        count: 0,
        message: 'No protected actions configured.',
      };
    }

    const protections = Object.entries(config.servers).map(([server, cfg]) => ({
      server,
      phrase: cfg.phrase,
      tools: cfg.tools,
      protection: cfg.protection,
      description: cfg.description,
    }));

    return {
      protections,
      count: protections.length,
      message: `Found ${protections.length} protected server(s).`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      protections: [],
      count: 0,
      message: `Error reading protected actions config: ${message}`,
    };
  }
}

/**
 * Get details of a pending protected action request by its code
 */
function getProtectedActionRequest(args: GetProtectedActionRequestArgs): GetProtectedActionRequestResult {
  try {
    if (!fs.existsSync(PROTECTED_APPROVALS_PATH)) {
      return {
        found: false,
        message: 'No pending approval requests.',
      };
    }

    const data = JSON.parse(fs.readFileSync(PROTECTED_APPROVALS_PATH, 'utf8'));
    const approvals: Record<string, ApprovalRequest> = data.approvals || {};
    const code = args.code.toUpperCase();

    const request = approvals[code];
    if (!request) {
      return {
        found: false,
        message: `No request found with code: ${code}`,
      };
    }

    // Check if expired
    if (Date.now() > request.expires_timestamp) {
      return {
        found: false,
        message: `Request with code ${code} has expired.`,
      };
    }

    return {
      found: true,
      request: {
        code: request.code,
        server: request.server,
        tool: request.tool,
        args: request.args,
        phrase: request.phrase,
        status: request.status,
        created_at: request.created_at,
        expires_at: request.expires_at,
      },
      message: request.status === 'approved'
        ? `Request ${code} is approved and ready to execute.`
        : `Request ${code} is pending CTO approval. Type: ${request.phrase} ${code}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      found: false,
      message: `Error reading approval requests: ${message}`,
    };
  }
}

// ============================================================================
// Deputy-CTO Protected Action Approval (Fix 8)
// ============================================================================

/**
 * Load protection key for HMAC signing.
 * @returns Base64-encoded key or null if not found
 */
function loadProtectionKey(): string | null {
  try {
    if (!fs.existsSync(PROTECTION_KEY_PATH)) {
      return null;
    }
    return fs.readFileSync(PROTECTION_KEY_PATH, 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * Compute HMAC-SHA256 over pipe-delimited fields.
 * Must match the gate hook's computeHmac function exactly.
 */
function computeHmac(key: string, ...fields: string[]): string {
  const keyBuffer = Buffer.from(key, 'base64');
  return crypto.createHmac('sha256', keyBuffer)
    .update(fields.join('|'))
    .digest('hex');
}

interface ApprovalsFile {
  approvals: Record<string, ApprovalRequest & {
    pending_hmac?: string;
    approved_hmac?: string;
    approval_mode?: string;
    is_preapproval?: boolean;
    reason?: string;
    max_uses?: number;
    uses_remaining?: number;
    burst_window_ms?: number;
    last_used_timestamp?: number | null;
  }>;
}

function loadApprovalsFile(): ApprovalsFile {
  try {
    if (!fs.existsSync(PROTECTED_APPROVALS_PATH)) {
      return { approvals: {} };
    }
    return JSON.parse(fs.readFileSync(PROTECTED_APPROVALS_PATH, 'utf8'));
  } catch {
    return { approvals: {} };
  }
}

function saveApprovalsFile(data: ApprovalsFile): void {
  const dir = path.dirname(PROTECTED_APPROVALS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = PROTECTED_APPROVALS_PATH + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    fs.renameSync(tmpPath, PROTECTED_APPROVALS_PATH);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

/**
 * Acquire an advisory lock on the approvals file.
 * Uses exclusive file creation (O_CREAT | O_EXCL) as a cross-process mutex.
 * Same pattern as protected-action-gate.js to prevent TOCTOU race conditions.
 * @returns true if lock acquired, false otherwise
 */
function acquireApprovalsLock(): boolean {
  const maxAttempts = 10;
  const baseDelay = 50; // ms
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const fd = fs.openSync(APPROVALS_LOCK_PATH, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch {
      // Check for stale lock (older than 10 seconds)
      try {
        const stat = fs.statSync(APPROVALS_LOCK_PATH);
        if (Date.now() - stat.mtimeMs > 10000) {
          fs.unlinkSync(APPROVALS_LOCK_PATH);
          continue; // Retry immediately after removing stale lock
        }
      } catch { /* lock file gone, retry */ }

      // Exponential backoff
      const delay = baseDelay * Math.pow(2, i);
      const start = Date.now();
      while (Date.now() - start < delay) { /* busy wait */ }
    }
  }
  return false;
}

/**
 * Release the advisory lock on the approvals file.
 */
function releaseApprovalsLock(): void {
  try {
    fs.unlinkSync(APPROVALS_LOCK_PATH);
  } catch { /* already released */ }
}

/**
 * Approve a protected action request (deputy-cto only).
 * Computes HMAC-signed approval that the gate hook will verify.
 */
function approveProtectedAction(args: ApproveProtectedActionArgs): ApproveProtectedActionResult | ErrorResult {
  const code = args.code.toUpperCase();

  // Acquire lock to prevent TOCTOU race on read-modify-write cycle
  if (!acquireApprovalsLock()) {
    return { error: `G001 FAIL-CLOSED: Could not acquire approvals lock for ${code}. Retry shortly.` };
  }

  try {
    const data = loadApprovalsFile();
    const request = data.approvals[code];

    if (!request) {
      return { error: `No pending request found with code: ${code}` };
    }

    if (request.status === 'approved') {
      return { error: `Request ${code} has already been approved.` };
    }

    if (Date.now() > request.expires_timestamp) {
      delete data.approvals[code];
      saveApprovalsFile(data);
      return { error: `Request ${code} has expired.` };
    }

    // Only deputy-cto-approval mode requests can be approved by deputy-cto
    if (request.approval_mode !== 'deputy-cto') {
      return {
        error: `Request ${code} requires CTO approval (mode: ${request.approval_mode || 'cto'}). Deputy-CTO cannot approve this action. Escalate to CTO queue.`,
      };
    }

    // Verify pending_hmac with protection key
    // G001 Fail-Closed: pending_hmac is verified unconditionally when a protection key is
    // present. If the field is missing (undefined), the comparison against the expected hex
    // string fails correctly, blocking requests that were not created by the gate hook.
    const key = loadProtectionKey();
    if (key) {
      const expectedPendingHmac = computeHmac(key, code, request.server, request.tool, request.argsHash || '', String(request.expires_timestamp));
      if (request.pending_hmac !== expectedPendingHmac) {
        // Forged or missing pending_hmac - delete it
        delete data.approvals[code];
        saveApprovalsFile(data);
        return { error: `FORGERY DETECTED: Invalid pending signature for ${code}. Request deleted.` };
      }
    } else if (request.pending_hmac) {
      // G001 Fail-Closed: Request has HMAC but we can't verify (key missing)
      return { error: `Cannot verify request signature for ${code} (protection key missing). Restore .claude/protection-key.` };
    } else {
      // G001 Fail-Closed: No protection key at all — cannot sign approvals
      return { error: `Protection key missing. Cannot create HMAC-signed approval. Restore .claude/protection-key.` };
    }

    // Compute approved_hmac (same algorithm as approval hook)
    request.status = 'approved';
    request.approved_at = new Date().toISOString();
    request.approved_timestamp = Date.now();
    request.approved_hmac = computeHmac(key, code, request.server, request.tool, 'approved', request.argsHash || '', String(request.expires_timestamp));

    saveApprovalsFile(data);

    return {
      approved: true,
      code,
      server: request.server,
      tool: request.tool,
      message: `Approved: ${request.server}.${request.tool} (code: ${code}). Agent can now retry the action.`,
    };
  } finally {
    releaseApprovalsLock();
  }
}

/**
 * Deny a protected action request (deputy-cto only).
 * Removes the pending entry from the approvals file.
 */
function denyProtectedAction(args: DenyProtectedActionArgs): DenyProtectedActionResult | ErrorResult {
  const code = args.code.toUpperCase();

  // Acquire lock to prevent TOCTOU race on read-modify-write cycle
  if (!acquireApprovalsLock()) {
    return { error: `G001 FAIL-CLOSED: Could not acquire approvals lock for ${code}. Retry shortly.` };
  }

  try {
    const data = loadApprovalsFile();
    const request = data.approvals[code];

    if (!request) {
      return { error: `No pending request found with code: ${code}` };
    }

    // Remove the request
    const server = request.server;
    const tool = request.tool;
    delete data.approvals[code];
    saveApprovalsFile(data);

    return {
      denied: true,
      code,
      reason: args.reason,
      message: `Denied: ${server}.${tool} (code: ${code}). Reason: ${args.reason}`,
    };
  } finally {
    releaseApprovalsLock();
  }
}

/**
 * List all pending (non-expired) protected action requests.
 * Used by deputy-cto during triage to discover pending requests.
 */
function listPendingActionRequests(): ListPendingActionRequestsResult {
  const data = loadApprovalsFile();
  const now = Date.now();
  const requests: PendingActionRequestItem[] = [];

  for (const [code, request] of Object.entries(data.approvals)) {
    if (request.status !== 'pending') continue;
    if (request.expires_timestamp < now) continue;

    requests.push({
      code,
      server: request.server,
      tool: request.tool,
      args: request.args,
      approval_mode: request.approval_mode || 'cto',
      created_at: request.created_at,
      expires_at: request.expires_at,
      expires_in_seconds: Math.floor((request.expires_timestamp - now) / 1000),
    });
  }

  return {
    requests,
    count: requests.length,
    message: requests.length === 0
      ? 'No pending protected action requests.'
      : `Found ${requests.length} pending request(s).`,
  };
}

// ============================================================================
// Pre-approved Bypass Functions
// ============================================================================

const MAX_ACTIVE_PREAPPROVALS = 5;
const BURST_WINDOW_MS = 60000; // 60 seconds

interface PreapprovalEntry {
  code: string;
  server: string;
  tool: string;
  status: 'pending' | 'approved';
  is_preapproval: true;
  approval_mode: 'cto';
  reason: string;
  max_uses: number;
  uses_remaining: number;
  burst_window_ms: number;
  last_used_timestamp: number | null;
  created_at: string;
  created_timestamp: number;
  expires_at: string;
  expires_timestamp: number;
  pending_hmac?: string;
  approved_hmac?: string;
}

/**
 * Request a pre-approved bypass for a protected action.
 * Creates a pending entry that must be activated via AskUserQuestion + activatePreapprovedBypass.
 */
function requestPreapprovedBypass(args: RequestPreapprovedBypassArgs): RequestPreapprovedBypassResult | ErrorResult {
  const { server, tool, reason, expiry_hours, max_uses } = args;

  // Validate server+tool exists in protected-actions.json
  try {
    if (!fs.existsSync(PROTECTED_ACTIONS_PATH)) {
      return { error: 'Protected actions config not found. Cannot create pre-approval.' };
    }
    const config = JSON.parse(fs.readFileSync(PROTECTED_ACTIONS_PATH, 'utf8')) as { servers: Record<string, { tools: string | string[] }> };
    const serverConfig = config.servers?.[server];
    if (!serverConfig) {
      return { error: `Server "${server}" not found in protected-actions.json.` };
    }
    if (serverConfig.tools !== '*' && (!Array.isArray(serverConfig.tools) || !serverConfig.tools.includes(tool))) {
      return { error: `Tool "${tool}" is not protected on server "${server}".` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to read protected actions config: ${message}` };
  }

  // Validate protection key exists
  const key = loadProtectionKey();
  if (!key) {
    return { error: 'Protection key missing. Cannot create HMAC-signed pre-approval. Restore .claude/protection-key.' };
  }

  if (!acquireApprovalsLock()) {
    return { error: 'Could not acquire approvals file lock. Try again.' };
  }

  try {
    const data = loadApprovalsFile();
    const now = Date.now();

    // Count active pre-approvals (non-expired, is_preapproval)
    let activeCount = 0;
    for (const entry of Object.values(data.approvals)) {
      if (entry.is_preapproval && entry.expires_timestamp > now) {
        activeCount++;
      }
    }
    if (activeCount >= MAX_ACTIVE_PREAPPROVALS) {
      return { error: `Too many active pre-approvals (max ${MAX_ACTIVE_PREAPPROVALS}). Wait for existing ones to expire or be consumed.` };
    }

    // Deduplication: only one per server+tool
    for (const entry of Object.values(data.approvals)) {
      if (entry.is_preapproval && entry.server === server && entry.tool === tool && entry.expires_timestamp > now) {
        return { error: `A pre-approval already exists for ${server}.${tool} (code: ${entry.code}). Wait for it to expire or be consumed.` };
      }
    }

    const code = generateBypassCode();
    const expiresTimestamp = now + (expiry_hours! * 60 * 60 * 1000);
    const pendingHmac = computeHmac(key, code, server, tool, 'preapproval-pending', String(expiresTimestamp));

    const entry: PreapprovalEntry = {
      code,
      server,
      tool,
      status: 'pending',
      is_preapproval: true,
      approval_mode: 'cto',
      reason,
      max_uses: max_uses!,
      uses_remaining: max_uses!,
      burst_window_ms: BURST_WINDOW_MS,
      last_used_timestamp: null,
      created_at: new Date(now).toISOString(),
      created_timestamp: now,
      expires_at: new Date(expiresTimestamp).toISOString(),
      expires_timestamp: expiresTimestamp,
      pending_hmac: pendingHmac,
    };

    data.approvals[code] = entry as unknown as ApprovalsFile['approvals'][string];
    saveApprovalsFile(data);

    return {
      code,
      server,
      tool,
      reason,
      expires_at: entry.expires_at,
      expiry_hours: expiry_hours!,
      max_uses: max_uses!,
      message: `Pre-approval request created (code: ${code}). CTO must confirm via AskUserQuestion, then call activate_preapproved_bypass.`,
      instructions: `Use AskUserQuestion to present this pre-approval to the CTO:\n- Server: ${server}\n- Tool: ${tool}\n- Reason: ${reason}\n- Expires in: ${expiry_hours} hours\n- Max uses: ${max_uses} (burst window: 60s after first use)\n\nIf CTO approves, call activate_preapproved_bypass with code "${code}".`,
    };
  } finally {
    releaseApprovalsLock();
  }
}

/**
 * Activate a pre-approved bypass after CTO confirmation.
 * Sets status to 'approved' and computes the activated HMAC.
 */
function activatePreapprovedBypass(args: ActivatePreapprovedBypassArgs): ActivatePreapprovedBypassResult | ErrorResult {
  const code = args.code.toUpperCase();

  const key = loadProtectionKey();
  if (!key) {
    return { error: 'Protection key missing. Cannot verify pre-approval. Restore .claude/protection-key.' };
  }

  if (!acquireApprovalsLock()) {
    return { error: 'Could not acquire approvals file lock. Try again.' };
  }

  try {
    const data = loadApprovalsFile();
    const entry = data.approvals[code] as unknown as PreapprovalEntry | undefined;

    if (!entry) {
      return { error: `No pre-approval request found with code: ${code}` };
    }

    if (!entry.is_preapproval) {
      return { error: `Entry ${code} is not a pre-approval. Use approve_protected_action for standard requests.` };
    }

    if (entry.status === 'approved') {
      return { error: `Pre-approval ${code} is already activated.` };
    }

    if (Date.now() > entry.expires_timestamp) {
      delete data.approvals[code];
      saveApprovalsFile(data);
      return { error: `Pre-approval ${code} has expired.` };
    }

    // Verify pending_hmac
    const expectedPendingHmac = computeHmac(key, code, entry.server, entry.tool, 'preapproval-pending', String(entry.expires_timestamp));
    if (entry.pending_hmac !== expectedPendingHmac) {
      delete data.approvals[code];
      saveApprovalsFile(data);
      return { error: `FORGERY DETECTED: Invalid pending signature for pre-approval ${code}. Entry deleted.` };
    }

    // Activate
    entry.status = 'approved';
    const approvedHmac = computeHmac(key, code, entry.server, entry.tool, 'preapproval-activated', String(entry.expires_timestamp));
    (entry as PreapprovalEntry & { approved_hmac: string }).approved_hmac = approvedHmac;

    data.approvals[code] = entry as unknown as ApprovalsFile['approvals'][string];
    saveApprovalsFile(data);

    return {
      activated: true,
      code,
      server: entry.server,
      tool: entry.tool,
      expires_at: entry.expires_at,
      message: `Pre-approval ${code} activated for ${entry.server}.${entry.tool}. ${entry.max_uses} uses available (burst window: 60s). Expires: ${entry.expires_at}.`,
    };
  } finally {
    releaseApprovalsLock();
  }
}

/**
 * List all non-expired pre-approvals with status, remaining uses, and time left.
 */
function listPreapprovedBypasses(_args: ListPreapprovedBypassesArgs): ListPreapprovedBypassesResult {
  const data = loadApprovalsFile();
  const now = Date.now();
  const bypasses: PreapprovedBypassItem[] = [];

  for (const entry of Object.values(data.approvals)) {
    const preapproval = entry as unknown as PreapprovalEntry;
    if (!preapproval.is_preapproval) continue;
    if (preapproval.expires_timestamp < now) continue;

    bypasses.push({
      code: preapproval.code,
      server: preapproval.server,
      tool: preapproval.tool,
      reason: preapproval.reason,
      status: preapproval.status,
      created_at: preapproval.created_at,
      expires_at: preapproval.expires_at,
      expires_in_hours: Math.round((preapproval.expires_timestamp - now) / (60 * 60 * 1000) * 10) / 10,
      max_uses: preapproval.max_uses,
      uses_remaining: preapproval.uses_remaining,
    });
  }

  return {
    bypasses,
    count: bypasses.length,
    message: bypasses.length === 0
      ? 'No active pre-approved bypasses.'
      : `Found ${bypasses.length} pre-approved bypass(es).`,
  };
}

// ============================================================================
// Hotfix Promotion Functions
// ============================================================================

function requestHotfixPromotion(_args: RequestHotfixPromotionArgs): RequestHotfixPromotionResult | ErrorResult {
  const gitOpts = { cwd: PROJECT_DIR, encoding: 'utf8' as const, timeout: 15000, stdio: 'pipe' as const };

  // Fetch latest
  try {
    execSync('git fetch origin staging main', gitOpts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to fetch origin: ${message}` };
  }

  // Get commits on staging ahead of main
  let commitLines: string[];
  try {
    const gitLog = execSync('git log origin/main..origin/staging --oneline', gitOpts).trim();
    commitLines = gitLog ? gitLog.split('\n') : [];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to compare staging and main: ${message}` };
  }

  if (commitLines.length === 0) {
    return { error: 'No commits on staging ahead of main. Nothing to hotfix.' };
  }

  const db = getDb();

  // Check no pending hotfix already exists
  const pendingHotfix = db.prepare(
    "SELECT id FROM hotfix_requests WHERE status = 'pending' AND expires_at > datetime('now')"
  ).get() as { id: number } | undefined;

  if (pendingHotfix) {
    return { error: `A pending hotfix request already exists (ID: ${pendingHotfix.id}). Wait for it to expire or be executed before requesting another.` };
  }

  // Generate 6-char code
  const code = crypto.randomBytes(3).toString('hex').toUpperCase();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 5 * 60 * 1000);

  db.prepare(`
    INSERT INTO hotfix_requests (code, commits_json, created_at, expires_at, status)
    VALUES (?, ?, ?, ?, 'pending')
  `).run(code, JSON.stringify(commitLines), now.toISOString(), expiresAt.toISOString());

  return {
    code,
    commits: commitLines,
    expires_at: expiresAt.toISOString(),
    message: `Hotfix promotion requested. ${commitLines.length} commit(s) on staging ahead of main. To approve, the CTO must type: APPROVE HOTFIX ${code} (expires in 5 minutes)`,
  };
}

function executeHotfixPromotion(_args: ExecuteHotfixPromotionArgs): ExecuteHotfixPromotionResult | ErrorResult {
  // Read approval token
  if (!fs.existsSync(HOTFIX_APPROVAL_TOKEN_PATH)) {
    return { error: 'No hotfix approval token found. The CTO must type "APPROVE HOTFIX <code>" first.' };
  }

  let token: {
    code: string;
    request_id: number;
    created_at: string;
    expires_at: string;
    hmac: string;
  };

  try {
    token = JSON.parse(fs.readFileSync(HOTFIX_APPROVAL_TOKEN_PATH, 'utf8'));
  } catch {
    return { error: 'Failed to read hotfix approval token. Ask the CTO to type the approval again.' };
  }

  // Empty object means consumed
  if (!token.code && !token.hmac) {
    return { error: 'No hotfix approval token found. The CTO must type "APPROVE HOTFIX <code>" first.' };
  }

  // Verify HMAC
  const key = loadProtectionKey();
  if (!key) {
    return { error: 'Protection key missing. Cannot verify hotfix approval token. Restore .claude/protection-key.' };
  }

  const expectedHmac = computeHmac(key, token.code, String(token.request_id), token.expires_at, 'hotfix-approved');
  if (token.hmac !== expectedHmac) {
    // Consume the forged token
    try { fs.writeFileSync(HOTFIX_APPROVAL_TOKEN_PATH, '{}'); } catch { /* ignore */ }
    return { error: 'FORGERY DETECTED: Invalid hotfix approval token signature. Token deleted.' };
  }

  // Check not expired
  if (new Date(token.expires_at).getTime() < Date.now()) {
    try { fs.writeFileSync(HOTFIX_APPROVAL_TOKEN_PATH, '{}'); } catch { /* ignore */ }
    return { error: 'Hotfix approval token has expired. Ask the CTO to approve again.' };
  }

  // Consume the token (one-time use)
  try { fs.writeFileSync(HOTFIX_APPROVAL_TOKEN_PATH, '{}'); } catch { /* ignore */ }

  // Update DB status
  const db = getDb();
  db.prepare("UPDATE hotfix_requests SET status = 'executed' WHERE id = ?").run(token.request_id);

  // Retrieve the commits for the prompt
  const row = db.prepare('SELECT commits_json FROM hotfix_requests WHERE id = ?').get(token.request_id) as { commits_json: string } | undefined;
  const commits: string[] = row ? JSON.parse(row.commits_json) : [];

  // Spawn the hotfix promotion agent
  const commitList = commits.join('\n');
  const hotfixPrompt = `[Task][hotfix-promotion] You are the EMERGENCY HOTFIX Promotion Pipeline.

## Mission

Immediately merge staging into main. This is a CTO-approved emergency hotfix that bypasses:
- The 24-hour stability requirement
- The midnight deployment window

Code review and quality checks still apply.

## Commits being promoted

\`\`\`
${commitList}
\`\`\`

## Process

### Step 1: Code Review

Spawn a code-reviewer sub-agent (Task tool, subagent_type: code-reviewer) to review the commits:
- Check for security issues, code quality, spec violations
- Look for disabled tests, placeholder code, hardcoded credentials
- Verify no spec violations (G001-G019)

### Step 2: Create and Merge PR

If code review passes:
1. Run: gh pr create --base main --head staging --title "HOTFIX: Emergency promotion staging -> main" --body "CTO-approved emergency hotfix. Bypasses 24h stability and midnight window."
2. Wait for CI: gh pr checks <number> --watch
3. If CI passes: gh pr merge <number> --merge
4. If CI fails: Report failure via mcp__agent-reports__report_to_deputy_cto

If code review fails:
- Report findings via mcp__agent-reports__report_to_deputy_cto with priority "critical"
- Do NOT proceed with merge

## Timeout

Complete within 25 minutes. If blocked, report and exit.`;

  try {
    const mcpConfig = path.join(PROJECT_DIR, '.mcp.json');
    const claude = spawn('claude', [
      '--dangerously-skip-permissions',
      '--mcp-config', mcpConfig,
      '--output-format', 'json',
      '-p',
      hotfixPrompt,
    ], {
      detached: true,
      stdio: 'ignore',
      cwd: PROJECT_DIR,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: PROJECT_DIR,
        CLAUDE_SPAWNED_SESSION: 'true',
        GENTYR_PROMOTION_PIPELINE: 'true',
      },
    });

    claude.unref();

    return {
      success: true,
      message: `Hotfix promotion agent spawned (PID: ${claude.pid}). Staging -> main promotion is in progress with code review. The 24h stability gate and midnight window are bypassed.`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to spawn hotfix promotion agent: ${message}` };
  }
}

// ============================================================================
// Promotion Bypass Functions
// ============================================================================

async function reviewBlockingItems(args: ReviewBlockingItemsArgs): Promise<string> {
  const db = getDb();

  // Get pending questions from deputy-cto.db
  const questions = db.prepare(
    "SELECT id, type, title, created_at, created_timestamp FROM questions WHERE status = 'pending' ORDER BY created_timestamp ASC"
  ).all() as Array<{ id: string; type: string; title: string; created_at: string; created_timestamp: string }>;

  // Get pending triage items from cto-reports.db
  type TriageRow = { id: string; title: string; created_at: string; created_timestamp: string };
  const triageItems: TriageRow[] = [];
  if (fs.existsSync(CTO_REPORTS_DB_PATH)) {
    try {
      const reportsDb = openReadonlyDb(CTO_REPORTS_DB_PATH);
      const columns = reportsDb.pragma('table_info(reports)') as { name: string }[];
      const hasTriageStatus = columns.some(c => c.name === 'triage_status');
      const hasCreatedTimestamp = columns.some(c => c.name === 'created_timestamp');

      if (hasTriageStatus) {
        const rows = reportsDb.prepare(
          `SELECT id, title, created_at${hasCreatedTimestamp ? ', created_timestamp' : ', 0 as created_timestamp'} FROM reports WHERE triage_status = 'pending' ORDER BY ${hasCreatedTimestamp ? 'created_timestamp' : 'created_at'} ASC`
        ).all() as TriageRow[];
        triageItems.push(...rows);
      } else {
        const rows = reportsDb.prepare(
          `SELECT id, title, created_at${hasCreatedTimestamp ? ', created_timestamp' : ', 0 as created_timestamp'} FROM reports WHERE triaged_at IS NULL ORDER BY ${hasCreatedTimestamp ? 'created_timestamp' : 'created_at'} ASC`
        ).all() as TriageRow[];
        triageItems.push(...rows);
      }
      reportsDb.close();
    } catch (err) {
      process.stderr.write(`[deputy-cto] review_blocking_items: Failed to read triage items: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  const now = Date.now();

  const questionItems: BlockingItemSummary[] = questions.map(item => {
    const ageHours = Math.round((now - new Date(item.created_timestamp).getTime()) / 3600000 * 10) / 10;

    let relevance: 'relevant' | 'likely_irrelevant' | 'unknown' = 'unknown';
    let relevanceReason = '';

    if (['bypass-request', 'protected-action-request', 'rejection'].includes(item.type)) {
      relevance = 'relevant';
      relevanceReason = `${item.type} requires CTO action`;
    } else if (['decision', 'question'].includes(item.type) && ageHours > 24) {
      relevance = 'likely_irrelevant';
      relevanceReason = `${item.type} older than 24h (${Math.floor(ageHours)}h) — likely stale`;
    } else if (item.type === 'escalation') {
      relevance = 'unknown';
      relevanceReason = 'Escalation needs CTO judgment';
    } else {
      relevance = 'unknown';
      relevanceReason = `${item.type} needs CTO review`;
    }

    return {
      id: item.id,
      type: item.type,
      title: item.title,
      created_at: item.created_at,
      age_hours: ageHours,
      relevance,
      relevance_reason: relevanceReason,
    };
  });

  const triageItemsSummary: BlockingItemSummary[] = triageItems.map(item => {
    const ageHours = item.created_timestamp
      ? Math.round((now - new Date(item.created_timestamp).getTime()) / 3600000 * 10) / 10
      : 0;

    const relevance: 'relevant' | 'likely_irrelevant' | 'unknown' = ageHours > 24 && ageHours > 0
      ? 'likely_irrelevant'
      : 'unknown';
    const relevanceReason = ageHours > 24 && ageHours > 0
      ? `Triage item older than 24h — likely stale`
      : 'Triage item needs review';

    return {
      id: String(item.id),
      type: 'triage',
      title: item.title,
      created_at: item.created_at,
      age_hours: ageHours,
      relevance,
      relevance_reason: relevanceReason,
    };
  });

  const allItems = [...questionItems, ...triageItemsSummary];

  const relevantCount = allItems.filter(i => i.relevance === 'relevant').length;
  const irrelevantCount = allItems.filter(i => i.relevance === 'likely_irrelevant').length;
  const unknownCount = allItems.filter(i => i.relevance === 'unknown').length;

  let recommendation = '';
  if (allItems.length === 0) {
    recommendation = 'No blocking items found.';
  } else if (relevantCount === 0 && irrelevantCount > 0) {
    recommendation = `All ${allItems.length} items appear stale/irrelevant. Recommend creating a bypass to unblock main.`;
  } else if (relevantCount > 0 && irrelevantCount > 0) {
    recommendation = `${relevantCount} of ${allItems.length} items appear relevant. Recommend addressing those ${relevantCount} and bypassing the remaining ${irrelevantCount}.`;
  } else if (relevantCount > 0) {
    recommendation = `${relevantCount} items require CTO action. Address these before bypassing.`;
  } else {
    recommendation = `${unknownCount} items need manual review to determine relevance.`;
  }

  const result: ReviewBlockingItemsResult = {
    total_blocking: allItems.length,
    relevant_count: relevantCount,
    irrelevant_count: irrelevantCount,
    unknown_count: unknownCount,
    items: allItems,
    deputy_recommendation: recommendation,
    bypass_eligible: irrelevantCount > 0 || (allItems.length > 0 && relevantCount === 0),
  };

  // Suppress unused-variable warning for optional context arg
  void args;

  return JSON.stringify(result, null, 2);
}

function createPromotionBypass(args: CreatePromotionBypassArgs): string {
  // CTO-only gate: block spawned (agent) sessions
  const isSpawned = process.env['CLAUDE_SPAWNED_SESSION'] === 'true';
  if (isSpawned) {
    return JSON.stringify({
      success: false,
      message: 'Promotion bypass can only be created in interactive (CTO) sessions.',
    });
  }

  const db = getDb();
  const id = randomUUID();
  const now = new Date();
  const nowTimestamp = now.toISOString();
  const durationMinutes = args.duration_minutes ?? 30;
  const expiresAt = new Date(now.getTime() + durationMinutes * 60 * 1000).toISOString();
  const createdAt = now.toISOString();

  db.prepare(`
    INSERT INTO commit_decisions (id, question_id, decision, rationale, created_timestamp, created_at)
    VALUES (?, NULL, 'approved', ?, ?, ?)
  `).run(
    id,
    `PROMOTION BYPASS (${durationMinutes}min) - ${args.rationale}`,
    nowTimestamp,
    createdAt
  );

  const result: CreatePromotionBypassResult = {
    success: true,
    bypass_id: id,
    expires_at: expiresAt,
    duration_minutes: durationMinutes,
    message: `Promotion bypass created. Commits to main unblocked for ${durationMinutes} minutes (until ${expiresAt}).`,
  };

  return JSON.stringify(result, null, 2);
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
  // Bypass governance tools
  {
    name: 'request_bypass',
    description: 'Request an emergency bypass from the CTO. Returns a 6-character code. STOP attempting commits and ask the CTO to type "APPROVE BYPASS <code>" in the chat. Only then call execute_bypass.',
    schema: RequestBypassArgsSchema,
    handler: requestBypass,
  },
  {
    name: 'execute_bypass',
    description: 'Execute a bypass AFTER the CTO has typed "APPROVE BYPASS <code>" in the chat. The UserPromptSubmit hook creates an approval token when the CTO types the approval phrase. This tool verifies that token exists.',
    schema: ExecuteBypassArgsSchema,
    handler: executeBypass,
  },
  // Protected action tools
  {
    name: 'list_protections',
    description: 'List all CTO-protected MCP actions. Shows which servers/tools require approval before execution.',
    schema: ListProtectionsArgsSchema,
    handler: listProtections,
  },
  {
    name: 'get_protected_action_request',
    description: 'Get details of a pending protected action request by its 6-character approval code. Use to check status before retrying a blocked action.',
    schema: GetProtectedActionRequestArgsSchema,
    handler: getProtectedActionRequest,
  },
  // Deputy-CTO protected action approval tools (Fix 8)
  {
    name: 'approve_protected_action',
    description: 'Approve a pending deputy-cto-approval protected action. Only works for actions with approval_mode "deputy-cto". Creates HMAC-signed approval.',
    schema: ApproveProtectedActionArgsSchema,
    handler: approveProtectedAction,
  },
  {
    name: 'deny_protected_action',
    description: 'Deny a pending protected action request. Removes the pending entry. Include a clear reason.',
    schema: DenyProtectedActionArgsSchema,
    handler: denyProtectedAction,
  },
  {
    name: 'list_pending_action_requests',
    description: 'List all pending (non-expired) protected action requests. Shows code, server, tool, args, and approval mode for each.',
    schema: ListPendingActionRequestsArgsSchema,
    handler: listPendingActionRequests,
  },
  // Pre-approved bypass tools
  {
    name: 'request_preapproved_bypass',
    description: 'Request a long-lived, burst-use pre-approval for a protected action. Creates a pending entry. After CTO confirms via AskUserQuestion, call activate_preapproved_bypass. Pre-approvals match ANY invocation of the server+tool (args-agnostic). Max 5 active, one per server+tool.',
    schema: RequestPreapprovedBypassArgsSchema,
    handler: requestPreapprovedBypass,
  },
  {
    name: 'activate_preapproved_bypass',
    description: 'Activate a pre-approved bypass after CTO confirmation via AskUserQuestion. Sets status to approved and computes HMAC signature. The pre-approval can then be consumed by any agent invoking the matching server+tool.',
    schema: ActivatePreapprovedBypassArgsSchema,
    handler: activatePreapprovedBypass,
  },
  {
    name: 'list_preapproved_bypasses',
    description: 'List all active (non-expired) pre-approved bypasses with status, remaining uses, and time until expiry.',
    schema: ListPreapprovedBypassesArgsSchema,
    handler: listPreapprovedBypasses,
  },
  {
    name: 'review_blocking_items',
    description: 'Review all pending items blocking commits to main. Classifies each by relevance (relevant, likely_irrelevant, unknown) and recommends which can be bypassed vs addressed. Use before create_promotion_bypass to understand the landscape.',
    schema: ReviewBlockingItemsArgsSchema,
    handler: reviewBlockingItems,
  },
  {
    name: 'create_promotion_bypass',
    description: 'Create a time-limited bypass allowing commits to main despite pending blocking items. CTO-only — blocked in spawned agent sessions. Use after reviewing blocking items with review_blocking_items.',
    schema: CreatePromotionBypassArgsSchema,
    handler: createPromotionBypass,
  },
  {
    name: 'get_merge_chain_status',
    description: 'Get the current merge chain status: branch positions, active/stale feature branches, uncommitted changes. Used for CTO briefing.',
    schema: GetMergeChainStatusArgsSchema,
    handler: getMergeChainStatus,
  },
  {
    name: 'request_hotfix_promotion',
    description: 'Request an emergency hotfix promotion from staging to main. Returns an approval code the CTO must type to authorize. Validates staging has commits ahead of main.',
    schema: RequestHotfixPromotionArgsSchema,
    handler: requestHotfixPromotion,
  },
  {
    name: 'execute_hotfix_promotion',
    description: 'Execute a CTO-approved emergency hotfix promotion from staging to main. Requires prior APPROVE HOTFIX approval. Bypasses 24h stability and midnight window.',
    schema: ExecuteHotfixPromotionArgsSchema,
    handler: executeHotfixPromotion,
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
