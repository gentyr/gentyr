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
import { spawn } from 'child_process';

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
  SpawnImplementationTaskArgsSchema,
  GetPendingCountArgsSchema,
  ToggleAutonomousModeArgsSchema,
  GetAutonomousModeStatusArgsSchema,
  RecordCtoBriefingArgsSchema,
  SearchClearedItemsArgsSchema,
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
  type SetAutomationModeArgs,
  type RequestBypassArgs,
  type ExecuteBypassArgs,
  type GetProtectedActionRequestArgs,
  type ApproveProtectedActionArgs,
  type DenyProtectedActionArgs,
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
  type RecordCtoBriefingResult,
  type SearchClearedItemsResult,
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
const PROTECTION_KEY_PATH = path.join(PROJECT_DIR, '.claude', 'protection-key');
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
    created_timestamp INTEGER NOT NULL,
    answered_at TEXT,
    decided_by TEXT,
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
    created_timestamp INTEGER NOT NULL,
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
  if (!questionsColumns.some(c => c.name === 'recommendation')) {
    db.exec('ALTER TABLE questions ADD COLUMN recommendation TEXT');
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

  const id = randomUUID();
  const now = new Date();
  const created_at = now.toISOString();
  const created_timestamp = Math.floor(now.getTime() / 1000);

  db.prepare(`
    INSERT INTO questions (id, type, status, title, description, context, suggested_options, recommendation, created_at, created_timestamp)
    VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    args.type,
    args.title,
    args.description,
    args.context ?? null,
    args.suggested_options ? JSON.stringify(args.suggested_options) : null,
    args.recommendation ?? null,
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
    recommendation: question.recommendation,
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

  // Empty object means token was consumed (overwrite pattern for sticky-bit compat)
  if (!token.code && !token.request_id && !token.expires_timestamp) {
    return {
      error: `No approval token found. The CTO must type "APPROVE BYPASS ${code}" to create an approval token.`,
    };
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
  const created_timestamp = Math.floor(now.getTime() / 1000);

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
  fs.writeFileSync(PROTECTED_APPROVALS_PATH, JSON.stringify(data, null, 2));
}

/**
 * Approve a protected action request (deputy-cto only).
 * Computes HMAC-signed approval that the gate hook will verify.
 */
function approveProtectedAction(args: ApproveProtectedActionArgs): ApproveProtectedActionResult | ErrorResult {
  const code = args.code.toUpperCase();
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
  const key = loadProtectionKey();
  if (key && request.pending_hmac) {
    const expectedPendingHmac = computeHmac(key, code, request.server, request.tool, request.argsHash || '', String(request.expires_timestamp));
    if (request.pending_hmac !== expectedPendingHmac) {
      // Forged request - delete it
      delete data.approvals[code];
      saveApprovalsFile(data);
      return { error: `FORGERY DETECTED: Invalid pending signature for ${code}. Request deleted.` };
    }
  } else if (!key && request.pending_hmac) {
    // G001 Fail-Closed: Request has HMAC but we can't verify (key missing)
    return { error: `Cannot verify request signature for ${code} (protection key missing). Restore .claude/protection-key.` };
  } else if (!key) {
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
}

/**
 * Deny a protected action request (deputy-cto only).
 * Removes the pending entry from the approvals file.
 */
function denyProtectedAction(args: DenyProtectedActionArgs): DenyProtectedActionResult | ErrorResult {
  const code = args.code.toUpperCase();
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
