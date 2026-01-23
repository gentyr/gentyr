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
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import Database from 'better-sqlite3';
import { McpServer, type ToolHandler } from '../shared/server.js';
import {
  AddQuestionArgsSchema,
  ListQuestionsArgsSchema,
  ReadQuestionArgsSchema,
  AnswerQuestionArgsSchema,
  ClearQuestionArgsSchema,
  ApproveCommitArgsSchema,
  RejectCommitArgsSchema,
  GetCommitDecisionArgsSchema,
  SpawnImplementationTaskArgsSchema,
  GetPendingCountArgsSchema,
  ToggleAutonomousModeArgsSchema,
  GetAutonomousModeStatusArgsSchema,
  SearchClearedItemsArgsSchema,
  CleanupOldRecordsArgsSchema,
  RequestBypassArgsSchema,
  ExecuteBypassArgsSchema,
  type AddQuestionArgs,
  type ListQuestionsArgs,
  type ReadQuestionArgs,
  type AnswerQuestionArgs,
  type ClearQuestionArgs,
  type ApproveCommitArgs,
  type RejectCommitArgs,
  type SpawnImplementationTaskArgs,
  type ToggleAutonomousModeArgs,
  type SearchClearedItemsArgs,
  type RequestBypassArgs,
  type ExecuteBypassArgs,
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
  type SpawnImplementationTaskResult,
  type GetPendingCountResult,
  type ToggleAutonomousModeResult,
  type GetAutonomousModeStatusResult,
  type SearchClearedItemsResult,
  type CleanupOldRecordsResult,
  type RequestBypassResult,
  type ExecuteBypassResult,
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
    answer TEXT,
    created_at TEXT NOT NULL,
    created_timestamp INTEGER NOT NULL,
    answered_at TEXT,
    decided_by TEXT,
    CONSTRAINT valid_type CHECK (type IN ('decision', 'approval', 'rejection', 'question', 'escalation', 'bypass-request')),
    CONSTRAINT valid_status CHECK (status IN ('pending', 'answered')),
    CONSTRAINT valid_decided_by CHECK (decided_by IS NULL OR decided_by IN ('cto', 'deputy-cto'))
);

CREATE TABLE IF NOT EXISTS commit_decisions (
    id TEXT PRIMARY KEY,
    decision TEXT NOT NULL,
    rationale TEXT NOT NULL,
    question_id TEXT,
    created_at TEXT NOT NULL,
    created_timestamp INTEGER NOT NULL,
    CONSTRAINT valid_decision CHECK (decision IN ('approved', 'rejected'))
);

CREATE TABLE IF NOT EXISTS cleared_questions (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    answer TEXT,
    answered_at TEXT,
    decided_by TEXT,
    cleared_at TEXT NOT NULL,
    cleared_timestamp INTEGER NOT NULL,
    CONSTRAINT valid_decided_by CHECK (decided_by IS NULL OR decided_by IN ('cto', 'deputy-cto'))
);

CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status);
CREATE INDEX IF NOT EXISTS idx_cleared_questions_cleared ON cleared_questions(cleared_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_questions_type ON questions(type);
CREATE INDEX IF NOT EXISTS idx_commit_decisions_created ON commit_decisions(created_timestamp DESC);
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

  // Migration: Add decided_by column if it doesn't exist (for existing databases)
  const questionsColumns = db.pragma('table_info(questions)') as { name: string }[];
  if (!questionsColumns.some(c => c.name === 'decided_by')) {
    db.exec('ALTER TABLE questions ADD COLUMN decided_by TEXT');
  }
  const clearedColumns = db.pragma('table_info(cleared_questions)') as { name: string }[];
  if (!clearedColumns.some(c => c.name === 'decided_by')) {
    db.exec('ALTER TABLE cleared_questions ADD COLUMN decided_by TEXT');
  }

  // Run cleanup on startup to prevent unbounded database growth
  // This is safe to call on every startup (idempotent)
  const cleanup = cleanupOldRecordsInternal(db);
  if (cleanup.commit_decisions_deleted > 0 || cleanup.cleared_questions_deleted > 0) {
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
    const reportsDb = new Database(CTO_REPORTS_DB_PATH, { readonly: true });
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

function addQuestion(args: AddQuestionArgs): AddQuestionResult {
  const db = getDb();

  const id = randomUUID();
  const now = new Date();
  const created_at = now.toISOString();
  const created_timestamp = Math.floor(now.getTime() / 1000);

  db.prepare(`
    INSERT INTO questions (id, type, status, title, description, context, suggested_options, created_at, created_timestamp)
    VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    args.type,
    args.title,
    args.description,
    args.context ?? null,
    args.suggested_options ? JSON.stringify(args.suggested_options) : null,
    created_at,
    created_timestamp
  );

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
    answer: question.answer,
    created_at: question.created_at,
    answered_at: question.answered_at,
  };
}

function answerQuestion(args: AnswerQuestionArgs): AnswerQuestionResult | ErrorResult {
  const db = getDb();
  const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(args.id) as QuestionRecord | undefined;

  if (!question) {
    return { error: `Question not found: ${args.id}` };
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

  const now = new Date();
  const cleared_at = now.toISOString();
  const cleared_timestamp = Math.floor(now.getTime() / 1000);

  // Archive the question before deleting
  db.prepare(`
    INSERT INTO cleared_questions (id, type, title, description, answer, answered_at, decided_by, cleared_at, cleared_timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    question.id,
    question.type,
    question.title,
    question.description,
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
const APPROVAL_TOKEN_PATH = path.join(PROJECT_DIR, '.claude', 'commit-approval-token.json');

function approveCommit(args: ApproveCommitArgs): ApproveCommitResult {
  const db = getDb();

  // Check for pending CTO questions (any type blocks commits)
  const pendingCount = getPendingCount();
  if (pendingCount > 0) {
    return {
      approved: false,
      decision_id: '',
      message: `Cannot approve commit: ${pendingCount} pending CTO question(s) must be addressed first.`,
    };
  }

  // Clear any existing decision
  clearLatestCommitDecision();

  const id = randomUUID();
  const now = new Date();
  const created_at = now.toISOString();
  const created_timestamp = Math.floor(now.getTime() / 1000);

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
    // Log but don't fail - the database decision is still recorded
    console.error(`Warning: Could not write approval token: ${err}`);
  }

  return {
    approved: true,
    decision_id: id,
    message: `Commit approved. Token written - retry your commit within 5 minutes.${diffHash ? ` (hash: ${diffHash})` : ''}`,
  };
}

function rejectCommit(args: RejectCommitArgs): RejectCommitResult {
  const db = getDb();

  // Clear any existing decision
  clearLatestCommitDecision();

  const decisionId = randomUUID();
  const questionId = randomUUID();
  const now = new Date();
  const created_at = now.toISOString();
  const created_timestamp = Math.floor(now.getTime() / 1000);

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

function spawnImplementationTask(args: SpawnImplementationTaskArgs): SpawnImplementationTaskResult {
  try {
    const taggedPrompt = `[Task] ${args.prompt}`;

    const claude = spawn('claude', [
      '--dangerously-skip-permissions',
      '-p',
      taggedPrompt,
    ], {
      detached: true,
      stdio: 'ignore',
      cwd: PROJECT_DIR,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: PROJECT_DIR,
        CLAUDE_SPAWNED_SESSION: 'true',
      },
    });

    claude.unref();

    return {
      spawned: true,
      pid: claude.pid ?? null,
      message: `Task spawned: ${args.description} (PID: ${claude.pid})`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      spawned: false,
      pid: null,
      message: `Failed to spawn task: ${message}`,
    };
  }
}

function getPendingCountTool(): GetPendingCountResult {
  const pendingCount = getPendingCount();
  const rejectionCount = getPendingRejectionCount();
  const pendingTriage = getPendingTriageCount();

  return {
    pending_count: pendingCount,
    rejection_count: rejectionCount,
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
    planExecutorEnabled: true,
    claudeMdRefactorEnabled: true,
    lastModified: null,
    modifiedBy: null,
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
      ? `Autonomous Deputy CTO Mode ENABLED. Plan execution and CLAUDE.md refactoring will run hourly.`
      : `Autonomous Deputy CTO Mode DISABLED. No hourly automations will run.`,
    nextRunIn,
  };
}

function getAutonomousModeStatus(): GetAutonomousModeStatusResult {
  const config = getAutonomousConfig();
  const nextRunIn = config.enabled ? getNextRunMinutes() : null;

  let message: string;
  if (!config.enabled) {
    message = 'Autonomous Deputy CTO Mode is DISABLED.';
  } else if (nextRunIn === null) {
    message = 'Autonomous Deputy CTO Mode is ENABLED. Status unknown (state file error).';
  } else if (nextRunIn === 0) {
    message = 'Autonomous Deputy CTO Mode is ENABLED. Ready to run (waiting for service trigger).';
  } else {
    message = `Autonomous Deputy CTO Mode is ENABLED. Next run in ~${nextRunIn} minute(s).`;
  }

  return {
    enabled: config.enabled,
    planExecutorEnabled: config.planExecutorEnabled,
    claudeMdRefactorEnabled: config.claudeMdRefactorEnabled,
    lastModified: config.lastModified,
    nextRunIn,
    message,
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
 */
function cleanupOldRecordsInternal(db: Database.Database): CleanupOldRecordsResult {
  // Clean commit_decisions: keep only last 100
  const commitDecisionsResult = db.prepare(`
    DELETE FROM commit_decisions WHERE id NOT IN (
      SELECT id FROM commit_decisions ORDER BY created_timestamp DESC LIMIT 100
    )
  `).run();

  // Clean cleared_questions: keep last 500 OR anything within 30 days
  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60);
  const clearedQuestionsResult = db.prepare(`
    DELETE FROM cleared_questions
    WHERE cleared_timestamp < ?
    AND id NOT IN (
      SELECT id FROM cleared_questions ORDER BY cleared_timestamp DESC LIMIT 500
    )
  `).run(thirtyDaysAgo);

  const commitDeleted = commitDecisionsResult.changes;
  const clearedDeleted = clearedQuestionsResult.changes;
  const totalDeleted = commitDeleted + clearedDeleted;

  let message: string;
  if (totalDeleted === 0) {
    message = 'No old records found to clean up. Database is within retention limits.';
  } else {
    message = `Cleaned up ${totalDeleted} old record(s): ${commitDeleted} commit decision(s), ${clearedDeleted} cleared question(s).`;
  }

  return {
    commit_decisions_deleted: commitDeleted,
    cleared_questions_deleted: clearedDeleted,
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
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Exclude confusing chars: 0/O, 1/I
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function requestBypass(args: RequestBypassArgs): RequestBypassResult {
  const db = getDb();

  const id = randomUUID();
  const bypassCode = generateBypassCode();
  const now = new Date();
  const created_at = now.toISOString();
  const created_timestamp = Math.floor(now.getTime() / 1000);

  const description = `**Bypass requested by:** ${args.reporting_agent}

**Reason:** ${args.reason}

${args.blocked_by ? `**Blocked by:** ${args.blocked_by}` : ''}

---

**CTO Action Required:**
To approve this bypass, type exactly: **APPROVE BYPASS ${bypassCode}**

This will create an approval token that allows the agent to execute the bypass.`;

  // Store bypass code in context field for validation
  db.prepare(`
    INSERT INTO questions (id, type, status, title, description, context, created_at, created_timestamp)
    VALUES (?, 'bypass-request', 'pending', ?, ?, ?, ?, ?)
  `).run(id, `Bypass Request: ${args.reason.substring(0, 100)}`, description, bypassCode, created_at, created_timestamp);

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
  };

  try {
    token = JSON.parse(fs.readFileSync(approvalTokenPath, 'utf8'));
  } catch {
    return { error: 'Failed to read approval token. Ask the CTO to type the approval again.' };
  }

  // Verify code matches
  if (token.code !== code) {
    return {
      error: `Approval token is for a different bypass code (${token.code}). Ask the CTO to type "APPROVE BYPASS ${code}"`,
    };
  }

  // Verify not expired
  if (Date.now() > token.expires_timestamp) {
    // Clean up expired token
    try { fs.unlinkSync(approvalTokenPath); } catch { /* ignore */ }
    return {
      error: `Approval token has expired. Ask the CTO to type "APPROVE BYPASS ${code}" again.`,
    };
  }

  // Step 4: Approval verified - record the bypass and clean up
  const bypassId = randomUUID();
  const now = new Date();
  const created_at = now.toISOString();
  const created_timestamp = Math.floor(now.getTime() / 1000);

  // Create an approval record that the pre-commit hook can check
  db.prepare(`
    INSERT INTO commit_decisions (id, decision, rationale, question_id, created_at, created_timestamp)
    VALUES (?, 'approved', ?, ?, ?, ?)
  `).run(bypassId, `EMERGENCY BYPASS - CTO typed "APPROVE BYPASS ${code}"`, question.id, created_at, created_timestamp);

  // Clear the bypass request from the queue
  db.prepare('DELETE FROM questions WHERE id = ?').run(question.id);

  // Delete the approval token (one-time use)
  try { fs.unlinkSync(approvalTokenPath); } catch { /* ignore */ }

  return {
    executed: true,
    message: `Bypass executed (Decision ID: ${bypassId}). The next commit will proceed without deputy-cto review. This is a ONE-TIME bypass.`,
  };
}

// ============================================================================
// Server Setup
// ============================================================================

const tools: ToolHandler[] = [
  {
    name: 'add_question',
    description: 'Add a question/decision request for the CTO. Use for decisions, approvals, or escalations from reports.',
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
    name: 'spawn_implementation_task',
    description: 'Spawn a background Claude instance to implement CTO feedback. Fire-and-forget.',
    schema: SpawnImplementationTaskArgsSchema,
    handler: spawnImplementationTask,
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
    description: 'Get the current status of Autonomous Deputy CTO Mode, including when next run will occur.',
    schema: GetAutonomousModeStatusArgsSchema,
    handler: getAutonomousModeStatus,
  },
  {
    name: 'search_cleared_items',
    description: 'Search previously cleared CTO questions by substring. Use to check if a CTO-PENDING note in a plan has been addressed.',
    schema: SearchClearedItemsArgsSchema,
    handler: searchClearedItems,
  },
  {
    name: 'cleanup_old_records',
    description: 'Clean up old records to prevent unbounded database growth. Retains last 100 commit decisions and cleared questions within 30 days (minimum 500). Automatically runs on startup.',
    schema: CleanupOldRecordsArgsSchema,
    handler: cleanupOldRecords,
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
