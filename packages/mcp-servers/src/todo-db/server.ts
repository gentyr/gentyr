#!/usr/bin/env node
/**
 * TODO Database MCP Server
 *
 * Provides task management via SQLite database.
 * SQLite-based task tracking for multi-agent coordination.
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (stdio MCP)
 *
 * @version 2.0.0
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { McpServer, type AnyToolHandler } from '../shared/server.js';
import {
  ListTasksArgsSchema,
  GetTaskArgsSchema,
  CreateTaskArgsSchema,
  StartTaskArgsSchema,
  CompleteTaskArgsSchema,
  DeleteTaskArgsSchema,
  GetSummaryArgsSchema,
  CleanupArgsSchema,
  GetSessionsForTaskArgsSchema,
  BrowseSessionArgsSchema,
  GetCompletedSinceArgsSchema,
  SummarizeWorkArgsSchema,
  GetWorklogArgsSchema,
  ListArchivedTasksArgsSchema,
  ListCategoriesArgsSchema,
  GetCategoryArgsSchema,
  CreateCategoryArgsSchema,
  UpdateCategoryArgsSchema,
  DeleteCategoryArgsSchema,
  VALID_SECTIONS,
  SECTION_CREATOR_RESTRICTIONS,
  FORCED_FOLLOWUP_CREATORS,
  GATE_BYPASS_CREATORS,
  URGENCY_AUTHORIZED_CREATORS,
  GateApproveTaskArgsSchema,
  GateKillTaskArgsSchema,
  GateEscalateTaskArgsSchema,
  UpdateTaskGateArgsSchema,
  ConfirmTaskGateArgsSchema,
  CheckTaskAuditArgsSchema,
  TaskAuditPassArgsSchema,
  TaskAuditFailArgsSchema,
  type ListTasksArgs,
  type GetTaskArgs,
  type CreateTaskArgs,
  type StartTaskArgs,
  type CompleteTaskArgs,
  type DeleteTaskArgs,
  type GetSessionsForTaskArgs,
  type BrowseSessionArgs,
  type GetCompletedSinceArgs,
  type SummarizeWorkArgs,
  type GetWorklogArgs,
  type ListArchivedTasksArgs,
  type ListCategoriesArgs,
  type GetCategoryArgs,
  type CreateCategoryArgs,
  type UpdateCategoryArgs,
  type DeleteCategoryArgs,
  type ListTasksResult,
  type TaskResponse,
  type TaskRecord,
  type CreateTaskResult,
  type StartTaskResult,
  type CompleteTaskResult,
  type DeleteTaskResult,
  type SummaryResult,
  type SectionStats,
  type CleanupResult,
  type GetSessionsForTaskResult,
  type BrowseSessionResult,
  type GetCompletedSinceResult,
  type SessionMessage,
  type ErrorResult,
  type ValidSection,
  type TaskPriority,
  type WorklogEntry,
  type WorklogMetrics,
  type SummarizeWorkResult,
  type GetWorklogResult,
  type ArchivedTask,
  type ListArchivedTasksResult,
  type ListCategoriesResult,
  type CategoryResponse,
  type CategoryRecord,
  type UpdateTaskGateArgs,
  type ConfirmTaskGateArgs,
  type CheckTaskAuditArgs,
  type TaskAuditPassArgs,
  type TaskAuditFailArgs,
} from './types.js';
import { GATE_EXEMPT_CATEGORIES } from '../shared/constants.js';

// ============================================================================
// Configuration
// ============================================================================

const PROJECT_DIR = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const DB_PATH = path.join(PROJECT_DIR, '.claude', 'todo.db');
const WORKLOG_DB_PATH = path.join(PROJECT_DIR, '.claude', 'worklog.db');
const SESSION_WINDOW_MINUTES = 5;

// ============================================================================
// Database Schema
// ============================================================================

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    section TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    title TEXT NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    assigned_by TEXT,
    metadata TEXT,
    created_timestamp INTEGER NOT NULL,
    completed_timestamp INTEGER,
    started_timestamp INTEGER,
    followup_enabled INTEGER NOT NULL DEFAULT 0,
    followup_section TEXT,
    followup_prompt TEXT,
    priority TEXT NOT NULL DEFAULT 'normal',
    CONSTRAINT valid_status CHECK (status IN ('pending', 'pending_review', 'in_progress', 'pending_audit', 'completed')),
    CONSTRAINT valid_priority CHECK (priority IN ('normal', 'urgent'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_section ON tasks(section);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_completed_timestamp ON tasks(completed_timestamp);

CREATE TABLE IF NOT EXISTS maintenance_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Mirrors tasks columns minus status (always 'completed') and metadata (unused legacy column).
CREATE TABLE IF NOT EXISTS archived_tasks (
    id TEXT PRIMARY KEY,
    section TEXT,
    category_id TEXT,
    title TEXT NOT NULL,
    description TEXT,
    assigned_by TEXT,
    priority TEXT NOT NULL DEFAULT 'normal',
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    created_timestamp INTEGER NOT NULL,
    completed_timestamp INTEGER,
    followup_enabled INTEGER NOT NULL DEFAULT 0,
    followup_section TEXT,
    followup_prompt TEXT,
    archived_at TEXT NOT NULL,
    archived_timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_archived_tasks_archived ON archived_tasks(archived_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_archived_tasks_section ON archived_tasks(section);
`;

const WORKLOG_SCHEMA = `
CREATE TABLE IF NOT EXISTS worklog_entries (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    session_id TEXT,
    agent_id TEXT,
    section TEXT NOT NULL,
    title TEXT NOT NULL,
    assigned_by TEXT,
    summary TEXT NOT NULL,
    success INTEGER NOT NULL DEFAULT 1,
    timestamp_assigned TEXT,
    timestamp_started TEXT,
    timestamp_completed TEXT NOT NULL,
    duration_assign_to_start_ms INTEGER,
    duration_start_to_complete_ms INTEGER,
    duration_assign_to_complete_ms INTEGER,
    tokens_input INTEGER,
    tokens_output INTEGER,
    tokens_cache_read INTEGER,
    tokens_cache_creation INTEGER,
    tokens_total INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_worklog_task_id ON worklog_entries(task_id);
CREATE INDEX IF NOT EXISTS idx_worklog_created_at ON worklog_entries(created_at);
`;

const CATEGORIES_SCHEMA = `
CREATE TABLE IF NOT EXISTS task_categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    sequence TEXT NOT NULL,
    prompt_template TEXT,
    model TEXT DEFAULT 'sonnet',
    creator_restrictions TEXT,
    force_followup INTEGER DEFAULT 0,
    urgency_authorized INTEGER DEFAULT 1,
    is_default INTEGER DEFAULT 0,
    deprecated_section TEXT UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
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
  db.exec(CATEGORIES_SCHEMA);

  // Auto-migration: add followup columns if missing (existing databases)
  try {
    db.prepare("SELECT followup_enabled FROM tasks LIMIT 0").run();
  } catch {
    db.exec("ALTER TABLE tasks ADD COLUMN followup_enabled INTEGER NOT NULL DEFAULT 0");
    db.exec("ALTER TABLE tasks ADD COLUMN followup_section TEXT");
    db.exec("ALTER TABLE tasks ADD COLUMN followup_prompt TEXT");
  }

  // Auto-migration: ensure DEPUTY-CTO is in CHECK constraint
  try {
    const testId = 'migration-check-' + Date.now();
    db.prepare("INSERT INTO tasks (id, section, status, title, created_at, created_timestamp) VALUES (?, 'DEPUTY-CTO', 'pending', '_migration_test', ?, ?)").run(testId, new Date().toISOString(), Math.floor(Date.now() / 1000));
    db.prepare("DELETE FROM tasks WHERE id = ?").run(testId);
  } catch {
    // Old CHECK constraint — recreate table preserving data
    db.exec("ALTER TABLE tasks RENAME TO tasks_old");
    db.exec(SCHEMA);
    db.exec(`INSERT INTO tasks (id, section, status, title, description, created_at, started_at, completed_at, assigned_by, metadata, created_timestamp, completed_timestamp, followup_enabled, followup_section, followup_prompt) SELECT id, section, status, title, description, created_at, started_at, completed_at, assigned_by, metadata, created_timestamp, completed_timestamp, COALESCE(followup_enabled, 0), followup_section, followup_prompt FROM tasks_old`);
    db.exec("DROP TABLE tasks_old");
  }

  // Auto-migration: ensure PRODUCT-MANAGER is in CHECK constraint
  try {
    const testId = 'migration-pm-check-' + Date.now();
    db.prepare("INSERT INTO tasks (id, section, status, title, created_at, created_timestamp) VALUES (?, 'PRODUCT-MANAGER', 'pending', '_migration_test', ?, ?)").run(testId, new Date().toISOString(), Math.floor(Date.now() / 1000));
    db.prepare("DELETE FROM tasks WHERE id = ?").run(testId);
  } catch {
    db.exec("ALTER TABLE tasks RENAME TO tasks_old");
    db.exec(SCHEMA);
    db.exec(`INSERT INTO tasks (id, section, status, title, description, created_at, started_at, completed_at, assigned_by, metadata, created_timestamp, completed_timestamp, followup_enabled, followup_section, followup_prompt, priority, started_timestamp) SELECT id, section, status, title, description, created_at, started_at, completed_at, assigned_by, metadata, created_timestamp, completed_timestamp, COALESCE(followup_enabled, 0), followup_section, followup_prompt, COALESCE(priority, 'normal'), started_timestamp FROM tasks_old`);
    db.exec("DROP TABLE tasks_old");
  }

  // Auto-migration: ensure DEMO-MANAGER is in CHECK constraint
  try {
    const testId = 'migration-dm-check-' + Date.now();
    db.prepare("INSERT INTO tasks (id, section, status, title, created_at, created_timestamp) VALUES (?, 'DEMO-MANAGER', 'pending', '_migration_test', ?, ?)").run(testId, new Date().toISOString(), Math.floor(Date.now() / 1000));
    db.prepare("DELETE FROM tasks WHERE id = ?").run(testId);
  } catch {
    db.exec("ALTER TABLE tasks RENAME TO tasks_old");
    db.exec(SCHEMA);
    db.exec(`INSERT INTO tasks (id, section, status, title, description, created_at, started_at, completed_at, assigned_by, metadata, created_timestamp, completed_timestamp, followup_enabled, followup_section, followup_prompt, priority, started_timestamp) SELECT id, section, status, title, description, created_at, started_at, completed_at, assigned_by, metadata, created_timestamp, completed_timestamp, COALESCE(followup_enabled, 0), followup_section, followup_prompt, COALESCE(priority, 'normal'), started_timestamp FROM tasks_old`);
    db.exec("DROP TABLE tasks_old");
  }

  // Auto-migration: ensure WORKSTREAM-MANAGER is in CHECK constraint
  try {
    const testId = 'migration-wm-check-' + Date.now();
    db.prepare("INSERT INTO tasks (id, section, status, title, created_at, created_timestamp) VALUES (?, 'WORKSTREAM-MANAGER', 'pending', '_migration_test', ?, ?)").run(testId, new Date().toISOString(), Math.floor(Date.now() / 1000));
    db.prepare("DELETE FROM tasks WHERE id = ?").run(testId);
  } catch {
    db.exec("ALTER TABLE tasks RENAME TO tasks_old");
    db.exec(SCHEMA);
    db.exec(`INSERT INTO tasks (id, section, status, title, description, created_at, started_at, completed_at, assigned_by, metadata, created_timestamp, completed_timestamp, followup_enabled, followup_section, followup_prompt, priority, started_timestamp) SELECT id, section, status, title, description, created_at, started_at, completed_at, assigned_by, metadata, created_timestamp, completed_timestamp, COALESCE(followup_enabled, 0), followup_section, followup_prompt, COALESCE(priority, 'normal'), started_timestamp FROM tasks_old`);
    db.exec("DROP TABLE tasks_old");
  }

  // Auto-migration: ensure pending_review is in status CHECK constraint
  try {
    const testId = 'migration-gate-status-' + Date.now();
    db.prepare("INSERT INTO tasks (id, status, title, created_at, created_timestamp) VALUES (?, 'pending_review', '_migration_test', ?, ?)").run(testId, new Date().toISOString(), Math.floor(Date.now() / 1000));
    db.prepare("DELETE FROM tasks WHERE id = ?").run(testId);
  } catch {
    db.exec("ALTER TABLE tasks RENAME TO tasks_old");
    db.exec(SCHEMA);
    db.exec(`INSERT INTO tasks (id, section, status, title, description, created_at, started_at, completed_at, assigned_by, metadata, created_timestamp, completed_timestamp, followup_enabled, followup_section, followup_prompt, priority, started_timestamp) SELECT id, section, status, title, description, created_at, started_at, completed_at, assigned_by, metadata, created_timestamp, completed_timestamp, COALESCE(followup_enabled, 0), followup_section, followup_prompt, COALESCE(priority, 'normal'), started_timestamp FROM tasks_old`);
    db.exec("DROP TABLE tasks_old");
  }

  // Auto-migration: relax section column — remove NOT NULL and CHECK constraint.
  // Tests by attempting to INSERT a row with section = NULL. If the old constraint
  // rejects it, the table is recreated without the NOT NULL / CHECK on section.
  try {
    const migTestId = 'migration-section-nullable-' + Date.now();
    db.prepare("INSERT INTO tasks (id, section, status, title, created_at, created_timestamp) VALUES (?, NULL, 'pending', '_migration_test', ?, ?)").run(migTestId, new Date().toISOString(), Math.floor(Date.now() / 1000));
    db.prepare("DELETE FROM tasks WHERE id = ?").run(migTestId);
    // Migration not needed — section column already allows NULL
  } catch {
    // Old NOT NULL or CHECK constraint still in place — recreate table.
    // We must only reference columns that exist in tasks_old. Any columns added
    // by later ALTER TABLE migrations (category_id, strict_infra_guidance, etc.)
    // may not exist in very old databases — use a minimal safe column list that
    // matches what every previous migration guarantees to exist.
    db.exec("ALTER TABLE tasks RENAME TO tasks_old");
    db.exec(SCHEMA);
    db.exec(`INSERT INTO tasks (id, section, status, title, description, created_at, started_at, completed_at, assigned_by, metadata, created_timestamp, completed_timestamp, followup_enabled, followup_section, followup_prompt, priority, started_timestamp)
      SELECT id, section, status, title, description, created_at, started_at, completed_at, assigned_by, metadata, created_timestamp, completed_timestamp, COALESCE(followup_enabled, 0), followup_section, followup_prompt, COALESCE(priority, 'normal'), started_timestamp
      FROM tasks_old`);
    db.exec("DROP TABLE tasks_old");
    // Backfill category_id where NULL using deprecated_section mapping
    db.exec("UPDATE tasks SET category_id = (SELECT id FROM task_categories WHERE deprecated_section = tasks.section) WHERE category_id IS NULL AND tasks.section IS NOT NULL");
  }

  // Auto-migration: add priority column if missing (existing databases)
  try {
    db.prepare("SELECT priority FROM tasks LIMIT 0").run();
  } catch {
    db.exec("ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'");
  }

  // Auto-migration: add started_timestamp column if missing (existing databases)
  try {
    db.prepare("SELECT started_timestamp FROM tasks LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE tasks ADD COLUMN started_timestamp INTEGER");
  }

  // Auto-migration: add user_prompt_uuids column if missing
  try {
    db.prepare("SELECT user_prompt_uuids FROM tasks LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE tasks ADD COLUMN user_prompt_uuids TEXT");
  }

  // Auto-migration: add user_prompt_uuids to archived_tasks if missing
  try {
    db.prepare("SELECT user_prompt_uuids FROM archived_tasks LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE archived_tasks ADD COLUMN user_prompt_uuids TEXT");
  }

  // Auto-migration: add persistent_task_id column if missing
  try {
    db.prepare("SELECT persistent_task_id FROM tasks LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE tasks ADD COLUMN persistent_task_id TEXT");
  }

  // Auto-migration: ensure strict_infra_guidance column exists.
  // Three cases: (a) fresh DB, (b) legacy DB with bridge_main_tree, (c) already migrated.
  try {
    db.prepare("SELECT strict_infra_guidance FROM tasks LIMIT 0").get();
    // Case (c): already migrated, no-op
  } catch {
    try {
      // Case (b): rename legacy column (SQLite >= 3.25)
      db.exec("ALTER TABLE tasks RENAME COLUMN bridge_main_tree TO strict_infra_guidance");
    } catch {
      // Case (a): fresh DB, add new column
      db.exec("ALTER TABLE tasks ADD COLUMN strict_infra_guidance INTEGER DEFAULT 0");
    }
  }

  // Auto-migration: add demo_involved column if missing
  try {
    db.prepare("SELECT demo_involved FROM tasks LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE tasks ADD COLUMN demo_involved INTEGER DEFAULT 0");
  }

  // Auto-migration: add category_id column to tasks if missing
  try {
    db.prepare("SELECT category_id FROM tasks LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE tasks ADD COLUMN category_id TEXT");
  }

  // Auto-migration: relax archived_tasks.section NOT NULL constraint and add category_id.
  // Tests by attempting to INSERT a row with section = NULL into archived_tasks. If the old
  // NOT NULL constraint rejects it, the table is recreated without the constraint and with
  // the category_id column. If section is already nullable, check for category_id separately.
  try {
    const archiveMigTestId = 'archive-migration-section-nullable-' + Date.now();
    const nowIso = new Date().toISOString();
    const nowTs = Math.floor(Date.now() / 1000);
    db.prepare("INSERT INTO archived_tasks (id, section, title, created_at, created_timestamp, archived_at, archived_timestamp) VALUES (?, NULL, '_migration_test', ?, ?, ?, ?)").run(archiveMigTestId, nowIso, nowTs, nowIso, nowTs);
    db.prepare("DELETE FROM archived_tasks WHERE id = ?").run(archiveMigTestId);
    // Section column already allows NULL — check for category_id separately
    try {
      db.prepare("SELECT category_id FROM archived_tasks LIMIT 0").get();
    } catch {
      db.exec("ALTER TABLE archived_tasks ADD COLUMN category_id TEXT");
    }
  } catch {
    // Old NOT NULL constraint in place — recreate table with relaxed constraint + category_id.
    // Preserve all existing data. user_prompt_uuids may or may not exist, so use a minimal
    // safe column list guaranteed by all previous migrations.
    db.exec("ALTER TABLE archived_tasks RENAME TO archived_tasks_old");
    db.exec(SCHEMA);
    // user_prompt_uuids was added by ALTER TABLE above (before the rename), so it exists in archived_tasks_old
    db.exec(`INSERT INTO archived_tasks (id, section, title, description, assigned_by, priority, created_at, started_at, completed_at, created_timestamp, completed_timestamp, followup_enabled, followup_section, followup_prompt, user_prompt_uuids, archived_at, archived_timestamp)
      SELECT id, section, title, description, assigned_by, COALESCE(priority, 'normal'), created_at, started_at, completed_at, created_timestamp, completed_timestamp, COALESCE(followup_enabled, 0), followup_section, followup_prompt, user_prompt_uuids, archived_at, archived_timestamp
      FROM archived_tasks_old`);
    db.exec("DROP TABLE archived_tasks_old");
  }

  // Auto-migration: add audit gate columns if missing
  try {
    db.prepare("SELECT gate_success_criteria FROM tasks LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE tasks ADD COLUMN gate_success_criteria TEXT");
    db.exec("ALTER TABLE tasks ADD COLUMN gate_verification_method TEXT");
    db.exec("ALTER TABLE tasks ADD COLUMN gate_status TEXT");
    db.exec("ALTER TABLE tasks ADD COLUMN gate_confirmed_at TEXT");
    db.exec("ALTER TABLE tasks ADD COLUMN gate_confirmed_by TEXT");
  }

  // Auto-migration: ensure pending_audit is in status CHECK constraint
  try {
    const testId = 'migration-audit-status-' + Date.now();
    db.prepare("INSERT INTO tasks (id, status, title, created_at, created_timestamp) VALUES (?, 'pending_audit', '_migration_test', ?, ?)").run(testId, new Date().toISOString(), Math.floor(Date.now() / 1000));
    db.prepare("DELETE FROM tasks WHERE id = ?").run(testId);
  } catch {
    db.exec("ALTER TABLE tasks RENAME TO tasks_old");
    db.exec(SCHEMA);
    db.exec(`INSERT INTO tasks (id, section, status, title, description, created_at, started_at, completed_at, assigned_by, metadata, created_timestamp, completed_timestamp, followup_enabled, followup_section, followup_prompt, priority, started_timestamp, category_id, user_prompt_uuids, persistent_task_id, strict_infra_guidance, demo_involved, gate_success_criteria, gate_verification_method, gate_status, gate_confirmed_at, gate_confirmed_by)
      SELECT id, section, status, title, description, created_at, started_at, completed_at, assigned_by, metadata, created_timestamp, completed_timestamp, COALESCE(followup_enabled, 0), followup_section, followup_prompt, COALESCE(priority, 'normal'), started_timestamp, category_id, user_prompt_uuids, persistent_task_id, strict_infra_guidance, demo_involved, gate_success_criteria, gate_verification_method, gate_status, gate_confirmed_at, gate_confirmed_by
      FROM tasks_old`);
    db.exec("DROP TABLE tasks_old");
  }

  // Auto-migration: create task_audits table
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_audits (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      success_criteria TEXT NOT NULL,
      verification_method TEXT NOT NULL,
      verdict TEXT,
      evidence TEXT,
      failure_reason TEXT,
      auditor_agent_id TEXT,
      requested_at TEXT NOT NULL,
      completed_at TEXT,
      attempt_number INTEGER DEFAULT 1
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_task_audits_task ON task_audits(task_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_task_audits_pending ON task_audits(verdict) WHERE verdict IS NULL");

  seedCategories(db);

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

let _worklogDb: Database.Database | null = null;

function initializeWorklogDatabase(): Database.Database {
  const dbDir = path.dirname(WORKLOG_DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database(WORKLOG_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(WORKLOG_SCHEMA);

  // Auto-migration: add category_id column to worklog_entries if missing
  try {
    db.prepare("SELECT category_id FROM worklog_entries LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE worklog_entries ADD COLUMN category_id TEXT");
  }

  return db;
}

function getWorklogDb(): Database.Database {
  if (!_worklogDb) {
    _worklogDb = initializeWorklogDatabase();
  }
  return _worklogDb;
}

function closeWorklogDb(): void {
  if (_worklogDb) {
    _worklogDb.close();
    _worklogDb = null;
  }
}

// ============================================================================
// Category Seeding
// ============================================================================

function seedCategories(db: Database.Database): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO task_categories (id, name, description, sequence, prompt_template, model, creator_restrictions, force_followup, urgency_authorized, is_default, deprecated_section)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const seeds = [
    {
      id: 'standard',
      name: 'Standard Development',
      description: 'Full development workflow: investigation, implementation, testing, review, alignment check, and merge.',
      sequence: JSON.stringify([
        { agent_type: 'investigator', label: 'Investigation', optional: false },
        { agent_type: 'code-writer', label: 'Implementation', optional: false },
        { agent_type: 'test-writer', label: 'Test Writing', optional: true },
        { agent_type: 'code-reviewer', label: 'Code Review', optional: false },
        { agent_type: 'user-alignment', label: 'Alignment Check', optional: true },
        { agent_type: 'project-manager', label: 'Merge', optional: false },
      ]),
      prompt_template: null,
      model: 'opus',
      creator_restrictions: null,
      force_followup: 0,
      urgency_authorized: 1,
      is_default: 1,
      deprecated_section: 'CODE-REVIEWER',
    },
    {
      id: 'deep-investigation',
      name: 'Deep Investigation',
      description: 'Research and analysis with alignment verification. No code changes.',
      sequence: JSON.stringify([
        { agent_type: 'investigator', label: 'Investigation', optional: false },
        { agent_type: 'user-alignment', label: 'Alignment Check', optional: false },
      ]),
      prompt_template: null,
      model: 'opus',
      creator_restrictions: null,
      force_followup: 0,
      urgency_authorized: 1,
      is_default: 0,
      deprecated_section: 'INVESTIGATOR & PLANNER',
    },
    {
      id: 'test-suite',
      name: 'Test Suite Work',
      description: 'Test writing, review, and merge.',
      sequence: JSON.stringify([
        { agent_type: 'test-writer', label: 'Test Writing', optional: false },
        { agent_type: 'code-reviewer', label: 'Code Review', optional: false },
        { agent_type: 'project-manager', label: 'Merge', optional: false },
      ]),
      prompt_template: null,
      model: 'sonnet',
      creator_restrictions: null,
      force_followup: 0,
      urgency_authorized: 1,
      is_default: 0,
      deprecated_section: 'TEST-WRITER',
    },
    {
      id: 'triage',
      name: 'Triage & Delegation',
      description: 'Deputy CTO triage, decomposition, and delegation.',
      sequence: JSON.stringify([
        { agent_type: 'deputy-cto', label: 'Triage & Delegation', optional: false },
      ]),
      prompt_template: null,
      model: 'opus',
      creator_restrictions: JSON.stringify(['deputy-cto', 'cto', 'human', 'demo', 'pr-reviewer', 'system-followup', 'persistent-monitor']),
      force_followup: 0,
      urgency_authorized: 1,
      is_default: 0,
      deprecated_section: 'DEPUTY-CTO',
    },
    {
      id: 'demo-design',
      name: 'Demo Design',
      description: 'Investigation, demo implementation, review, and merge.',
      sequence: JSON.stringify([
        { agent_type: 'investigator', label: 'Investigation', optional: false },
        { agent_type: 'demo-manager', label: 'Demo Implementation', optional: false },
        { agent_type: 'code-reviewer', label: 'Code Review', optional: false },
        { agent_type: 'project-manager', label: 'Merge', optional: false },
      ]),
      prompt_template: null,
      model: 'sonnet',
      creator_restrictions: null,
      force_followup: 0,
      urgency_authorized: 1,
      is_default: 0,
      deprecated_section: 'DEMO-MANAGER',
    },
    {
      id: 'project-management',
      name: 'Project Management',
      description: 'Single-step project management workflow for commits, PRs, and cleanup',
      sequence: JSON.stringify([
        { agent_type: 'project-manager', label: 'Project Management' },
      ]),
      prompt_template: null,
      model: 'sonnet',
      creator_restrictions: null,
      force_followup: 0,
      urgency_authorized: 1,
      is_default: 0,
      deprecated_section: 'PROJECT-MANAGER',
    },
    {
      id: 'product-analysis',
      name: 'Product Analysis',
      description: 'Single-step product analysis workflow for market research and PMF analysis',
      sequence: JSON.stringify([
        { agent_type: 'product-manager', label: 'Product Analysis' },
      ]),
      prompt_template: null,
      model: 'opus',
      creator_restrictions: null,
      force_followup: 0,
      urgency_authorized: 1,
      is_default: 0,
      deprecated_section: 'PRODUCT-MANAGER',
    },
    {
      id: 'workstream-management',
      name: 'Workstream Management',
      description: 'Single-step workstream analysis and dependency management',
      sequence: JSON.stringify([
        { agent_type: 'workstream-manager', label: 'Workstream Management' },
      ]),
      prompt_template: null,
      model: 'sonnet',
      creator_restrictions: null,
      force_followup: 0,
      urgency_authorized: 0,
      is_default: 0,
      deprecated_section: 'WORKSTREAM-MANAGER',
    },
    {
      id: 'quick-fix',
      name: 'Quick Fix',
      description: 'Lightweight pipeline for single-file, obvious fixes (null guards, config changes, one-liner patches). Skips investigation and review for speed.',
      sequence: JSON.stringify([
        { agent_type: 'code-writer', label: 'Implement Fix', optional: false },
        { agent_type: 'project-manager', label: 'Merge', optional: false },
      ]),
      prompt_template: null,
      model: 'sonnet',
      creator_restrictions: null,
      force_followup: 0,
      urgency_authorized: 1,
      is_default: 0,
      deprecated_section: null,
    },
    {
      id: 'demo-iteration',
      name: 'Demo Iteration',
      description: 'Fix a demo scenario failure based on diagnostic data, then verify the demo passes before merging. Tight fix-verify loop.',
      sequence: JSON.stringify([
        { agent_type: 'code-writer', label: 'Implement Fix', optional: false },
        { agent_type: 'demo-manager', label: 'Verify Demo Passes', optional: false },
        { agent_type: 'project-manager', label: 'Merge', optional: false },
      ]),
      prompt_template: null,
      model: 'sonnet',
      creator_restrictions: null,
      force_followup: 0,
      urgency_authorized: 1,
      is_default: 0,
      deprecated_section: null,
    },
  ];

  const seedTx = db.transaction(() => {
    for (const seed of seeds) {
      insert.run(
        seed.id, seed.name, seed.description, seed.sequence, seed.prompt_template,
        seed.model, seed.creator_restrictions, seed.force_followup,
        seed.urgency_authorized, seed.is_default, seed.deprecated_section
      );
    }
  });
  seedTx();
}

// ============================================================================
// Helper Functions
// ============================================================================

function taskToResponse(task: TaskRecord): TaskResponse {
  let userPromptUuids: string[] | null = null;
  if (task.user_prompt_uuids) {
    try {
      userPromptUuids = JSON.parse(task.user_prompt_uuids);
    } catch {
      // Corrupt JSON — treat as null
    }
  }

  // Look up category name if category_id exists
  let categoryName: string | null = null;
  if (task.category_id) {
    try {
      const db = getDb();
      const cat = db.prepare('SELECT name FROM task_categories WHERE id = ?')
        .get(task.category_id) as { name: string } | undefined;
      categoryName = cat?.name ?? null;
    } catch {
      // Non-fatal: category name lookup failure leaves it as null
    }
  }

  return {
    id: task.id,
    section: task.section,
    status: task.status,
    title: task.title,
    description: task.description,
    created_at: task.created_at,
    started_at: task.started_at,
    completed_at: task.completed_at,
    assigned_by: task.assigned_by,
    followup_enabled: task.followup_enabled === 1,
    priority: (task.priority ?? 'normal') as TaskPriority,
    user_prompt_uuids: userPromptUuids,
    persistent_task_id: task.persistent_task_id ?? null,
    strict_infra_guidance: task.strict_infra_guidance === 1,
    demo_involved: task.demo_involved === 1,
    category_id: task.category_id ?? null,
    category_name: categoryName,
  };
}

// ============================================================================
// Follow-up Prompt Builder
// ============================================================================

function buildDefaultFollowupPrompt(title: string, description: string | null): string {
  const originalTask = description
    ? `Title: ${title}\nDescription: ${description}`
    : `Title: ${title}`;

  return `[Follow-up Verification] Earlier, you spawned agents or created to-do items to complete the following task. This is a reminder to verify that the task was completed.

If the task wasn't worked on at all, just stop here without further action — you'll be re-spawned later with this same prompt.

If it was partially completed but not to your satisfaction, spawn sessions or create to-do items for the appropriate agents to resolve the discrepancies.

If fully completed, mark this follow-up task as complete.

[Original Task]:
${originalTask}`;
}

// ============================================================================
// Worklog Helpers
// ============================================================================

function extractTokensFromSession(sessionFile: string): { input: number; output: number; cache_read: number; cache_creation: number; total: number } | null {
  try {
    if (!fs.existsSync(sessionFile)) return null;
    const content = fs.readFileSync(sessionFile, 'utf8');
    const lines = content.trim().split('\n');

    let input = 0;
    let output = 0;
    let cache_read = 0;
    let cache_creation = 0;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const usage = entry?.message?.usage;
        if (usage) {
          input += usage.input_tokens || 0;
          output += usage.output_tokens || 0;
          cache_read += usage.cache_read_input_tokens || 0;
          cache_creation += usage.cache_creation_input_tokens || 0;
        }
      } catch {
        // Skip unparseable lines
      }
    }

    const total = input + output;
    if (total === 0) return null;
    return { input, output, cache_read, cache_creation, total };
  } catch {
    return null;
  }
}

function resolveAgentTaskId(): string | null {
  const agentId = process.env.CLAUDE_AGENT_ID;
  if (!agentId) return null;

  try {
    const historyPath = path.join(PROJECT_DIR, '.claude', 'agent-tracker-history.json');
    if (!fs.existsSync(historyPath)) return null;
    const history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));

    const record = history[agentId];
    if (record?.metadata?.taskId) return record.metadata.taskId;

    return null;
  } catch {
    return null;
  }
}

// ============================================================================
// Tool Implementations
// ============================================================================

function listTasks(args: ListTasksArgs): ListTasksResult {
  const db = getDb();
  let sql = 'SELECT * FROM tasks WHERE 1=1';
  const params: unknown[] = [];

  if (args.category_id) {
    sql += ' AND category_id = ?';
    params.push(args.category_id);
  } else if (args.section) {
    sql += ' AND section = ?';
    params.push(args.section);
  }
  if (args.status) {
    sql += ' AND status = ?';
    params.push(args.status);
  }
  if (args.priority) {
    sql += ' AND priority = ?';
    params.push(args.priority);
  }

  sql += ' ORDER BY created_timestamp DESC';

  const limit = args.limit ?? 50;
  sql += ' LIMIT ?';
  params.push(limit);

  const tasks = db.prepare(sql).all(...params) as TaskRecord[];

  return {
    tasks: tasks.map(taskToResponse),
    total: tasks.length,
  };
}

function getTask(args: GetTaskArgs): TaskResponse | ErrorResult {
  const db = getDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(args.id) as TaskRecord | undefined;

  if (!task) {
    return { error: `Task not found: ${args.id}` };
  }

  return taskToResponse(task);
}

function createTask(args: CreateTaskArgs): CreateTaskResult | ErrorResult {
  const db = getDb();

  // Category resolution — determines both resolvedCategoryId and resolvedSection.
  // Resolution order: category_id wins > section lookup > default category.
  let resolvedCategoryId: string | null = null;
  let resolvedSection: string | null = null;

  if (args.category_id) {
    // Direct category lookup — category_id takes precedence over section.
    const cat = db.prepare('SELECT id, deprecated_section FROM task_categories WHERE id = ?')
      .get(args.category_id) as { id: string; deprecated_section: string | null } | undefined;
    if (!cat) {
      return { error: `Category not found: ${args.category_id}` };
    }
    resolvedCategoryId = cat.id;
    // Derive section from: explicit section arg > category's deprecated_section > null for custom categories
    resolvedSection = args.section ?? cat.deprecated_section ?? null;
  } else if (args.section) {
    // Legacy path: resolve section string to category via deprecated_section mapping.
    if (!(VALID_SECTIONS as readonly string[]).includes(args.section)) {
      return { error: `Invalid section: ${args.section}. Must be one of: ${VALID_SECTIONS.join(', ')}` };
    }
    const cat = db.prepare('SELECT id FROM task_categories WHERE deprecated_section = ?')
      .get(args.section) as { id: string } | undefined;
    resolvedCategoryId = cat?.id ?? null;
    resolvedSection = args.section;
  } else {
    // Neither provided: use default category.
    const cat = db.prepare('SELECT id, deprecated_section FROM task_categories WHERE is_default = 1')
      .get() as { id: string; deprecated_section: string | null } | undefined;
    if (cat) {
      resolvedCategoryId = cat.id;
      resolvedSection = cat.deprecated_section ?? null;
    } else {
      return { error: 'No section or category_id provided, and no default category exists.' };
    }
  }

  // Soft access control — check category creator_restrictions first, then fall back to section restrictions.
  if (resolvedCategoryId) {
    const cat = db.prepare('SELECT creator_restrictions FROM task_categories WHERE id = ?')
      .get(resolvedCategoryId) as { creator_restrictions: string | null } | undefined;
    if (cat?.creator_restrictions) {
      const restrictions = JSON.parse(cat.creator_restrictions) as string[];
      if (!args.assigned_by || !restrictions.includes(args.assigned_by)) {
        const gotValue = args.assigned_by ?? '(none)';
        return {
          error: `Category '${resolvedCategoryId}' requires assigned_by to be one of: ${restrictions.join(', ')}. Got: '${gotValue}'`,
        };
      }
    }
  } else if (resolvedSection) {
    // No category resolved but section is known — fall back to section-based restrictions.
    const restrictions = SECTION_CREATOR_RESTRICTIONS[resolvedSection as ValidSection];
    if (restrictions) {
      if (!args.assigned_by || !restrictions.includes(args.assigned_by)) {
        const gotValue = args.assigned_by ?? '(none)';
        return {
          error: `Section '${resolvedSection}' requires assigned_by to be one of: ${restrictions.join(', ')}. Got: '${gotValue}'`,
        };
      }
    }
  }

  // Follow-up enforcement for forced creators
  let followup_enabled = args.followup_enabled ?? false;
  let followup_section = args.followup_section ?? args.section ?? resolvedSection ?? null;
  let followup_prompt = args.followup_prompt ?? null;
  let warning: string | undefined;

  if (args.assigned_by && (FORCED_FOLLOWUP_CREATORS as readonly string[]).includes(args.assigned_by)) {
    // Reject tasks without a description — forced-followup creators must provide context
    if (!args.description?.trim()) {
      return {
        error: `Tasks created by ${args.assigned_by} require a description. The description is used to generate a follow-up verification prompt.`,
      };
    }

    if (args.followup_enabled === false) {
      warning = `Follow-up hooks cannot be disabled for tasks created by ${args.assigned_by}. Enabled automatically.`;
    }
    followup_enabled = true;

    // Auto-generate verification prompt if not provided
    if (!followup_prompt) {
      followup_prompt = buildDefaultFollowupPrompt(args.title, args.description);
    }
  }

  // Auto-enable followup when user_prompt_uuids is non-empty
  const userPromptUuids = args.user_prompt_uuids?.length ? args.user_prompt_uuids : null;
  if (userPromptUuids && !followup_enabled) {
    followup_enabled = true;
    if (!followup_prompt) {
      followup_prompt = buildDefaultFollowupPrompt(args.title, args.description ?? null);
    }
  }

  // Demo task auto-correction: enforce strict_infra_guidance and demo-design category
  let effectiveStrictInfra = args.strict_infra_guidance ?? false;
  if (args.demo_involved) {
    // Rule 1: demo_involved forces strict_infra_guidance
    if (!effectiveStrictInfra) {
      effectiveStrictInfra = true;
      const w = warning ? warning + ' | ' : '';
      warning = w + 'demo_involved=true requires strict_infra_guidance=true. Auto-enabled.';
    }

    // Rule 2: demo_involved forces demo-design category
    if (resolvedCategoryId !== 'demo-design') {
      const demoCategory = db.prepare('SELECT id, deprecated_section FROM task_categories WHERE id = ?')
        .get('demo-design') as { id: string; deprecated_section: string | null } | undefined;
      if (demoCategory) {
        const originalCategory = resolvedCategoryId ?? resolvedSection ?? '(default)';
        resolvedCategoryId = demoCategory.id;
        resolvedSection = demoCategory.deprecated_section ?? resolvedSection;
        const w = warning ? warning + ' | ' : '';
        warning = w + `demo_involved=true auto-routed from '${originalCategory}' to 'demo-design'.`;
      }
    }
  }

  const id = randomUUID();
  const now = new Date();
  const created_at = now.toISOString();
  const created_timestamp = Math.floor(now.getTime() / 1000);

  let priority = args.priority ?? 'normal';
  const userPromptUuidsJson = userPromptUuids ? JSON.stringify(userPromptUuids) : null;
  const persistentTaskId = args.persistent_task_id ?? null;
  const strictInfraGuidance = effectiveStrictInfra ? 1 : 0;
  const demoInvolved = args.demo_involved ? 1 : 0;

  // Audit gate setup — gate_success_criteria wins over verification_strategy alias
  const gateSuccessCriteria = args.gate_success_criteria ?? args.verification_strategy ?? null;
  const gateVerificationMethod = args.gate_verification_method ?? null;
  const gateStatus = gateSuccessCriteria ? 'draft' : null;

  // Mandatory audit gate: non-exempt categories MUST provide gate_success_criteria
  const isGateExempt = resolvedCategoryId && (GATE_EXEMPT_CATEGORIES as readonly string[]).includes(resolvedCategoryId);
  if (!isGateExempt && !gateSuccessCriteria) {
    return {
      error: 'Non-exempt tasks require gate_success_criteria (or verification_strategy). Provide measurable success criteria for the audit gate, or use a gate-exempt category (triage, project-management, workstream-management).',
    };
  }

  // Urgency auto-downgrade: only authorized creators can set urgent priority
  if (priority === 'urgent' && (!args.assigned_by || !(URGENCY_AUTHORIZED_CREATORS as readonly string[]).includes(args.assigned_by))) {
    priority = 'normal';
    const w = warning ? warning + ' | ' : '';
    warning = w + `Urgency downgrade: '${args.assigned_by || '(none)'}' is not urgency-authorized. Priority set to 'normal'.`;
  }

  // Gate status: trusted creators bypass to 'pending', others enter 'pending_review'
  const isTrustedCreator = !!args.assigned_by && (GATE_BYPASS_CREATORS as readonly string[]).includes(args.assigned_by);
  const taskStatus = isTrustedCreator ? 'pending' : 'pending_review';

  try {
    db.prepare(`
      INSERT INTO tasks (id, section, category_id, status, title, description, assigned_by, created_at, created_timestamp, followup_enabled, followup_section, followup_prompt, priority, user_prompt_uuids, persistent_task_id, strict_infra_guidance, demo_involved, gate_success_criteria, gate_verification_method, gate_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, resolvedSection, resolvedCategoryId, taskStatus, args.title, args.description ?? null, args.assigned_by ?? null, created_at, created_timestamp, followup_enabled ? 1 : 0, followup_section, followup_prompt, priority, userPromptUuidsJson, persistentTaskId, strictInfraGuidance, demoInvolved, gateSuccessCriteria, gateVerificationMethod, gateStatus);
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      (err as Error & { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
    ) {
      // Fallback: return the record that won the race
      const fallback = resolvedSection
        ? db.prepare(`SELECT * FROM tasks WHERE section = ? AND title = ? AND status != 'completed'`).get(resolvedSection, args.title) as TaskRecord | undefined
        : db.prepare(`SELECT * FROM tasks WHERE section IS NULL AND title = ? AND status != 'completed'`).get(args.title) as TaskRecord | undefined;
      if (fallback) {return taskToResponse(fallback);}
    }
    throw err; // Re-throw unexpected errors
  }

  // Look up category name for the response
  let createdCategoryName: string | null = null;
  if (resolvedCategoryId) {
    try {
      const catRow = db.prepare('SELECT name FROM task_categories WHERE id = ?')
        .get(resolvedCategoryId) as { name: string } | undefined;
      createdCategoryName = catRow?.name ?? null;
    } catch {
      // Non-fatal
    }
  }

  return {
    id,
    section: resolvedSection,
    status: taskStatus,
    title: args.title,
    description: args.description ?? null,
    created_at,
    started_at: null,
    completed_at: null,
    assigned_by: args.assigned_by ?? null,
    followup_enabled,
    priority: priority as TaskPriority,
    user_prompt_uuids: userPromptUuids,
    persistent_task_id: persistentTaskId,
    strict_infra_guidance: strictInfraGuidance === 1,
    demo_involved: demoInvolved === 1,
    category_id: resolvedCategoryId,
    category_name: createdCategoryName,
    gate_status: gateStatus,
    gate_success_criteria: gateSuccessCriteria,
    gate_verification_method: gateVerificationMethod,
    warning: gateStatus === 'draft'
      ? (warning ? warning + ' | ' : '') + 'Gate is DRAFT. You MUST spawn a user-alignment sub-agent to review the gate criteria against user prompts, then call confirm_task_gate to make the task spawnable.'
      : warning,
  };
}

function startTask(args: StartTaskArgs): StartTaskResult | ErrorResult {
  const db = getDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(args.id) as TaskRecord | undefined;

  if (!task) {
    return { error: `Task not found: ${args.id}` };
  }

  if (task.status === 'pending_review') {
    return { error: `Task is pending gate review and cannot be started yet: ${args.id}` };
  }

  if (task.status === 'completed') {
    return { error: `Task already completed: ${args.id}` };
  }

  if (task.status === 'in_progress') {
    return { error: `Task already in progress: ${args.id}` };
  }

  const now = new Date();
  const started_at = now.toISOString();
  const started_timestamp = Math.floor(now.getTime() / 1000);

  db.prepare(`
    UPDATE tasks SET status = 'in_progress', started_at = ?, started_timestamp = ?
    WHERE id = ?
  `).run(started_at, started_timestamp, args.id);

  return {
    id: args.id,
    status: 'in_progress',
    started_at,
  };
}

function completeTask(args: CompleteTaskArgs): CompleteTaskResult | ErrorResult {
  const db = getDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(args.id) as TaskRecord | undefined;

  if (!task) {
    return { error: `Task not found: ${args.id}` };
  }

  if (task.status === 'completed') {
    return { error: `Task already completed: ${args.id}` };
  }

  // Evaluate force_complete first — CTO interactive sessions can override all gates
  const isForceComplete = args.force_complete && process.env.CLAUDE_SPAWNED_SESSION !== 'true';

  if (task.status === 'pending_audit' && !isForceComplete) {
    return { error: `Task is pending audit — wait for the auditor verdict: ${args.id}` };
  }

  // Block completion when gate is draft (not confirmed)
  if (task.gate_status === 'draft' && !isForceComplete) {
    return {
      error: `Task has a DRAFT gate that has not been confirmed. Call confirm_task_gate first, or pass force_complete:true if you are the CTO in an interactive session.`,
    };
  }

  const now = new Date();
  const completed_at = now.toISOString();
  const completed_timestamp = Math.floor(now.getTime() / 1000);

  // Audit gate routing: if gate is active and not force_complete, route to pending_audit
  const hasActiveGate = task.gate_status === 'active' && task.gate_success_criteria;

  // Check if the task's category is gate-exempt (compare category ID directly)
  const isGateExempt = !!task.category_id && (GATE_EXEMPT_CATEGORIES as readonly string[]).includes(task.category_id);

  if (hasActiveGate && !isForceComplete && !isGateExempt) {
    // Route to pending_audit — create audit record
    const auditId = randomUUID();
    const attemptNumber = ((db.prepare('SELECT MAX(attempt_number) as max_attempt FROM task_audits WHERE task_id = ?').get(args.id) as { max_attempt: number | null })?.max_attempt ?? 0) + 1;

    db.prepare("UPDATE tasks SET status = 'pending_audit' WHERE id = ?").run(args.id);
    db.prepare(`
      INSERT INTO task_audits (id, task_id, success_criteria, verification_method, requested_at, attempt_number)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(auditId, args.id, task.gate_success_criteria!, task.gate_verification_method ?? '', now.toISOString(), attemptNumber);

    return {
      id: args.id,
      status: 'pending_audit',
      gate_success_criteria: task.gate_success_criteria!,
      gate_verification_method: task.gate_verification_method ?? undefined,
    };
  }

  // Direct completion (no gate, force_complete, or exempt category)
  db.prepare(`
    UPDATE tasks SET status = 'completed', completed_at = ?, completed_timestamp = ?
    WHERE id = ?
  `).run(completed_at, completed_timestamp, args.id);

  let followup_task_id: string | undefined;

  // Trigger follow-up hook
  if (task.followup_enabled) {
    const followupId = randomUUID();
    const section = task.followup_section ?? task.section;
    const title = `[Follow-up] ${task.title}`;
    const description = task.followup_prompt;
    const followup_created_at = now.toISOString();
    const followup_timestamp = Math.floor(now.getTime() / 1000);

    db.prepare(`
      INSERT INTO tasks (id, section, category_id, status, title, description, assigned_by, created_at, created_timestamp, followup_enabled, followup_section, followup_prompt)
      VALUES (?, ?, ?, 'pending', ?, ?, 'system-followup', ?, ?, 0, NULL, NULL)
    `).run(followupId, section, task.category_id ?? null, title, description, followup_created_at, followup_timestamp);

    followup_task_id = followupId;
  }

  return {
    id: args.id,
    status: 'completed',
    completed_at,
    followup_task_id,
  };
}

function deleteTask(args: DeleteTaskArgs): DeleteTaskResult | ErrorResult {
  const db = getDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(args.id) as TaskRecord | undefined;

  if (!task) {
    return { error: `Task not found: ${args.id}` };
  }

  let archived = false;

  if (task.status === 'completed') {
    // Archive completed tasks before deleting
    const now = new Date();
    const archived_at = now.toISOString();
    const archived_timestamp = Math.floor(now.getTime() / 1000);

    const category_id = task.category_id ?? null;

    const archiveAndDelete = db.transaction(() => {
      db.prepare(`
        INSERT OR REPLACE INTO archived_tasks (id, section, category_id, title, description, assigned_by, priority, created_at, started_at, completed_at, created_timestamp, completed_timestamp, followup_enabled, followup_section, followup_prompt, archived_at, archived_timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        task.id, task.section, category_id, task.title, task.description, task.assigned_by,
        task.priority ?? 'normal', task.created_at, task.started_at, task.completed_at,
        task.created_timestamp, task.completed_timestamp, task.followup_enabled,
        task.followup_section, task.followup_prompt, archived_at, archived_timestamp
      );
      db.prepare('DELETE FROM tasks WHERE id = ?').run(args.id);
    });
    archiveAndDelete();
    archived = true;
  } else {
    db.prepare('DELETE FROM tasks WHERE id = ?').run(args.id);
  }

  return {
    deleted: true,
    id: args.id,
    archived,
  };
}

function getSummary(): SummaryResult {
  const db = getDb();

  const result: SummaryResult = {
    total: 0,
    pending: 0,
    in_progress: 0,
    completed: 0,
    by_section: {},
    by_category: {},
  };

  // Initialize all sections
  for (const section of VALID_SECTIONS) {
    result.by_section[section] = { pending: 0, in_progress: 0, completed: 0 };
  }

  interface CountRow {
    section: string | null;
    status: string;
    count: number;
  }

  const tasks = db.prepare('SELECT section, status, COUNT(*) as count FROM tasks GROUP BY section, status').all() as CountRow[];

  for (const row of tasks) {
    result.total += row.count;
    // Aggregate pending_review into pending for display
    const displayStatus = row.status === 'pending_review' ? 'pending' : row.status;
    result[displayStatus as keyof Pick<SummaryResult, 'pending' | 'in_progress' | 'completed'>] += row.count;
    if (row.section && result.by_section[row.section]) {
      (result.by_section[row.section] as SectionStats)[displayStatus as keyof SectionStats] = (
        ((result.by_section[row.section] as SectionStats)[displayStatus as keyof SectionStats] || 0) + row.count
      );
    }
  }

  // Build by_category grouping
  interface CategoryCountRow {
    category_id: string;
    status: string;
    count: number;
    name: string;
  }

  const categoryCounts = db.prepare(`
    SELECT t.category_id, t.status, COUNT(*) as count, c.name
    FROM tasks t
    JOIN task_categories c ON c.id = t.category_id
    WHERE t.category_id IS NOT NULL
    GROUP BY t.category_id, t.status
  `).all() as CategoryCountRow[];

  for (const row of categoryCounts) {
    if (!result.by_category[row.category_id]) {
      result.by_category[row.category_id] = { name: row.name, pending: 0, in_progress: 0, completed: 0 };
    }
    const catDisplayStatus = row.status === 'pending_review' ? 'pending' : row.status;
    const catStats = result.by_category[row.category_id] as unknown as Record<string, unknown>;
    catStats[catDisplayStatus] = ((catStats[catDisplayStatus] as number) || 0) + row.count;
  }

  return result;
}

function cleanup(): CleanupResult {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const nowIso = new Date().toISOString();
  const changes = {
    stale_starts_cleared: 0,
    old_completed_archived: 0,
    completed_cap_archived: 0,
    archived_pruned: 0,
  };

  // Clear stale starts (>30 min without completion)
  const staleResult = db.prepare(`
    UPDATE tasks
    SET status = 'pending', started_at = NULL, started_timestamp = NULL
    WHERE status = 'in_progress'
      AND started_timestamp IS NOT NULL
      AND (? - started_timestamp) > 1800
  `).run(now);
  changes.stale_starts_cleared = staleResult.changes;

  // Archive completed tasks older than 3 hours
  const archiveOld = db.transaction(() => {
    const insertResult = db.prepare(`
      INSERT OR REPLACE INTO archived_tasks (id, section, category_id, title, description, assigned_by, priority, created_at, started_at, completed_at, created_timestamp, completed_timestamp, followup_enabled, followup_section, followup_prompt, archived_at, archived_timestamp)
      SELECT id, section, category_id, title, description, assigned_by, priority, created_at, started_at, completed_at, created_timestamp, completed_timestamp, followup_enabled, followup_section, followup_prompt, ?, ?
      FROM tasks
      WHERE status = 'completed'
        AND completed_timestamp IS NOT NULL
        AND (? - completed_timestamp) > 10800
    `).run(nowIso, now, now);

    db.prepare(`
      DELETE FROM tasks
      WHERE status = 'completed'
        AND completed_timestamp IS NOT NULL
        AND (? - completed_timestamp) > 10800
    `).run(now);

    return insertResult.changes;
  });
  changes.old_completed_archived = archiveOld();

  // Cap completed tasks at 50 (archive overflow, keep most recent)
  interface CountResult { count: number }
  const completedCount = (db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'completed'").get() as CountResult).count;
  if (completedCount > 50) {
    const toRemove = completedCount - 50;
    const archiveCap = db.transaction(() => {
      const insertResult = db.prepare(`
        INSERT INTO archived_tasks (id, section, category_id, title, description, assigned_by, priority, created_at, started_at, completed_at, created_timestamp, completed_timestamp, followup_enabled, followup_section, followup_prompt, archived_at, archived_timestamp)
        SELECT id, section, category_id, title, description, assigned_by, priority, created_at, started_at, completed_at, created_timestamp, completed_timestamp, followup_enabled, followup_section, followup_prompt, ?, ?
        FROM tasks
        WHERE status = 'completed'
        ORDER BY completed_timestamp ASC
        LIMIT ?
      `).run(nowIso, now, toRemove);

      db.prepare(`
        DELETE FROM tasks WHERE id IN (
          SELECT id FROM tasks
          WHERE status = 'completed'
          ORDER BY completed_timestamp ASC
          LIMIT ?
        )
      `).run(toRemove);

      return insertResult.changes;
    });
    changes.completed_cap_archived = archiveCap();
  }

  // Prune old archived tasks: keep last 500 OR anything within 30 days
  const thirtyDaysAgo = now - (30 * 24 * 60 * 60);
  const pruneResult = db.prepare(`
    DELETE FROM archived_tasks
    WHERE id NOT IN (
      SELECT id FROM archived_tasks ORDER BY archived_timestamp DESC LIMIT 500
    )
    AND archived_timestamp < ?
  `).run(thirtyDaysAgo);
  changes.archived_pruned = pruneResult.changes;

  return {
    ...changes,
    message: `Cleanup complete: ${changes.stale_starts_cleared} stale starts cleared, ${changes.old_completed_archived} old completed archived, ${changes.completed_cap_archived} completed cap archived, ${changes.archived_pruned} archives pruned`,
  };
}

function getSessionsForTask(args: GetSessionsForTaskArgs): GetSessionsForTaskResult | ErrorResult {
  const db = getDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(args.id) as TaskRecord | undefined;

  if (!task) {
    return { error: `Task not found: ${args.id}` };
  }

  if (task.status !== 'completed') {
    return { error: `Task not completed: ${args.id}. Only completed tasks have session attribution.` };
  }

  if (!task.completed_timestamp) {
    return { error: `Task missing completion timestamp: ${args.id}` };
  }

  // Find session directory
  // Claude stores sessions in ~/.claude/projects/ with path format: all non-alphanumeric chars → '-'
  const projectPath = PROJECT_DIR.replace(/[^a-zA-Z0-9]/g, '-');
  const sessionDir = path.join(os.homedir(), '.claude', 'projects', projectPath);

  if (!fs.existsSync(sessionDir)) {
    return {
      task_id: args.id,
      completed_at: task.completed_at ?? '',
      candidate_sessions: [],
      note: 'Session directory not found',
    };
  }

  // Find all sessions within time window
  const completionTime = Number(task.completed_timestamp) * 1000; // Convert to ms

  try {
    const files = fs.readdirSync(sessionDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const filePath = path.join(sessionDir, f);
        const stat = fs.statSync(filePath);
        const mtime = stat.mtime.getTime();
        const timeDiff = Math.abs(mtime - completionTime);
        return {
          session_id: f.replace('.jsonl', ''),
          mtime: new Date(mtime).toISOString(),
          time_diff_minutes: Math.round(timeDiff / 60000),
        };
      })
      .filter(f => f.time_diff_minutes <= SESSION_WINDOW_MINUTES)
      .sort((a, b) => a.time_diff_minutes - b.time_diff_minutes);

    return {
      task_id: args.id,
      completed_at: task.completed_at ?? '',
      candidate_sessions: files,
      note: files.length > 0
        ? `${files.length} session(s) found within ${SESSION_WINDOW_MINUTES}-min window. Use browse_session to explore each.`
        : `No sessions found within ${SESSION_WINDOW_MINUTES}-min window of completion time.`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      task_id: args.id,
      completed_at: task.completed_at ?? '',
      candidate_sessions: [],
      note: '',
      error: `Error reading sessions: ${message}`,
    };
  }
}

function browseSession(args: BrowseSessionArgs): BrowseSessionResult | ErrorResult {
  // Find session directory
  // Claude stores sessions in ~/.claude/projects/ with path format: all non-alphanumeric chars → '-'
  const projectPath = PROJECT_DIR.replace(/[^a-zA-Z0-9]/g, '-');
  const sessionDir = path.join(os.homedir(), '.claude', 'projects', projectPath);
  const sessionFile = path.join(sessionDir, `${args.session_id}.jsonl`);

  if (!fs.existsSync(sessionFile)) {
    return { error: `Session file not found: ${args.session_id}` };
  }

  try {
    const content = fs.readFileSync(sessionFile, 'utf8');
    const lines = content.trim().split('\n').filter(l => l.trim());
    const limit = args.limit ?? 100;

    const messages: SessionMessage[] = [];
    let messageCount = 0;
    let parseErrors = 0;

    interface RawEntry {
      type?: string;
      message?: string | { content?: Array<{ type: string; text?: string }> };
      content?: string;
      tool_use_id?: string;
    }

    for (let i = 0; i < lines.length; i++) {
      if (messages.length >= limit) {break;}
      const line = lines[i];

      try {
        const entry = JSON.parse(line) as RawEntry;
        messageCount++;

        if (entry.type === 'human') {
          messages.push({
            type: 'human',
            content: typeof entry.message === 'string'
              ? entry.message.substring(0, 500)
              : JSON.stringify(entry.message).substring(0, 500),
          });
        } else if (entry.type === 'assistant') {
          let text = '';
          if (entry.message && typeof entry.message === 'object' && Array.isArray(entry.message.content)) {
            for (const block of entry.message.content) {
              if (block.type === 'text' && block.text) {
                text += block.text;
              }
            }
          }
          messages.push({
            type: 'assistant',
            content: text.substring(0, 500),
          });
        } else if (entry.type === 'tool_result') {
          messages.push({
            type: 'tool_result',
            tool_use_id: entry.tool_use_id,
            content: typeof entry.content === 'string'
              ? entry.content.substring(0, 200)
              : '[complex content]',
          });
        }
      } catch (err) {
        // G001: Always log parse errors with context
        const errorMsg = err instanceof Error ? err.message : String(err);
        parseErrors++;
        process.stderr.write(
          `[todo-db] Parse error in session ${args.session_id} line ${i + 1}: ${errorMsg}\n`
        );
      }
    }

    // Log summary if there were parse errors
    if (parseErrors > 0) {
      process.stderr.write(`[todo-db] Session ${args.session_id}: ${parseErrors}/${lines.length} lines failed to parse\n`);
    }

    return {
      session_id: args.session_id,
      message_count: messageCount,
      messages_returned: messages.length,
      messages,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Error reading session: ${message}` };
  }
}

function getCompletedSince(args: GetCompletedSinceArgs): GetCompletedSinceResult {
  const db = getDb();
  const hours = args.hours ?? 24;
  const since = Date.now() - (hours * 60 * 60 * 1000);
  const sinceTimestamp = Math.floor(since / 1000);

  interface CountRow {
    section: string | null;
    count: number;
  }

  const rows = db.prepare(`
    SELECT section, COUNT(*) as count
    FROM tasks
    WHERE status = 'completed' AND completed_timestamp >= ?
    GROUP BY section
    ORDER BY count DESC
  `).all(sinceTimestamp) as CountRow[];

  // Filter out null-section rows for by_section (keep backward compat)
  const bySectionRows = rows.filter((r): r is { section: string; count: number } => r.section !== null);

  const total = rows.reduce((sum, row) => sum + row.count, 0);

  interface CategoryCountRow {
    category_id: string;
    count: number;
  }

  const byCategoryRows = db.prepare(`
    SELECT category_id, COUNT(*) as count
    FROM tasks
    WHERE status = 'completed' AND completed_timestamp >= ? AND category_id IS NOT NULL
    GROUP BY category_id
    ORDER BY count DESC
  `).all(sinceTimestamp) as CategoryCountRow[];

  return {
    hours,
    since: new Date(since).toISOString(),
    total,
    by_section: bySectionRows,
    by_category: byCategoryRows,
  };
}

function summarizeWork(args: SummarizeWorkArgs): SummarizeWorkResult | ErrorResult {
  // Resolve task_id
  let taskId = args.task_id;
  if (!taskId) {
    taskId = resolveAgentTaskId() ?? undefined;
    if (!taskId) {
      return { error: 'Could not resolve task_id. Provide it explicitly or ensure CLAUDE_AGENT_ID is set with agent-tracker metadata.' };
    }
  }

  const db = getDb();
  const worklogDb = getWorklogDb();

  // Look up task from todo.db
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRecord | undefined;

  const section = task?.section ?? 'UNKNOWN';
  const category_id = task?.category_id ?? null;
  const title = task?.title ?? 'Unknown task';
  const assigned_by = task?.assigned_by ?? null;
  const timestamp_assigned = task?.created_at ?? null;
  const timestamp_started = task?.started_at ?? null;
  const timestamp_completed = task?.completed_at ?? new Date().toISOString();

  // Compute durations
  let duration_assign_to_start_ms: number | null = null;
  let duration_start_to_complete_ms: number | null = null;
  let duration_assign_to_complete_ms: number | null = null;

  if (timestamp_assigned && timestamp_started) {
    duration_assign_to_start_ms = new Date(timestamp_started).getTime() - new Date(timestamp_assigned).getTime();
  }
  if (timestamp_started && timestamp_completed) {
    duration_start_to_complete_ms = new Date(timestamp_completed).getTime() - new Date(timestamp_started).getTime();
  }
  if (timestamp_assigned && timestamp_completed) {
    duration_assign_to_complete_ms = new Date(timestamp_completed).getTime() - new Date(timestamp_assigned).getTime();
  }

  // Attempt token extraction
  let tokens: { input: number; output: number; cache_read: number; cache_creation: number; total: number } | null = null;

  // Try to find session file via agent-tracker
  const agentId = process.env.CLAUDE_AGENT_ID;
  if (agentId) {
    try {
      const historyPath = path.join(PROJECT_DIR, '.claude', 'agent-tracker-history.json');
      if (fs.existsSync(historyPath)) {
        const history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
        const record = history[agentId];
        if (record?.sessionFile && fs.existsSync(record.sessionFile)) {
          tokens = extractTokensFromSession(record.sessionFile);
        }
      }
    } catch {
      // Non-fatal: tokens will be null
    }
  }

  // If no tokens from agent-tracker, try finding session by timestamp proximity
  if (!tokens && timestamp_completed) {
    try {
      const projectPath = PROJECT_DIR.replace(/[^a-zA-Z0-9]/g, '-');
      const sessionDir = path.join(os.homedir(), '.claude', 'projects', projectPath);
      if (fs.existsSync(sessionDir)) {
        const completionTime = new Date(timestamp_completed).getTime();
        const files = fs.readdirSync(sessionDir)
          .filter(f => f.endsWith('.jsonl'))
          .map(f => {
            const stat = fs.statSync(path.join(sessionDir, f));
            return { file: f, mtime: stat.mtime.getTime(), diff: Math.abs(stat.mtime.getTime() - completionTime) };
          })
          .filter(f => f.diff <= 5 * 60 * 1000)
          .sort((a, b) => a.diff - b.diff);

        if (files.length > 0) {
          tokens = extractTokensFromSession(path.join(sessionDir, files[0].file));
        }
      }
    } catch {
      // Non-fatal
    }
  }

  const session_id = process.env.CLAUDE_SESSION_ID ?? null;

  const id = randomUUID();
  const now = new Date().toISOString();

  worklogDb.prepare(`
    INSERT INTO worklog_entries (
      id, task_id, session_id, agent_id, section, category_id, title, assigned_by,
      summary, success, timestamp_assigned, timestamp_started, timestamp_completed,
      duration_assign_to_start_ms, duration_start_to_complete_ms, duration_assign_to_complete_ms,
      tokens_input, tokens_output, tokens_cache_read, tokens_cache_creation, tokens_total,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, taskId, session_id, agentId ?? null, section, category_id, title, assigned_by,
    args.summary, args.success ? 1 : 0, timestamp_assigned, timestamp_started, timestamp_completed,
    duration_assign_to_start_ms, duration_start_to_complete_ms, duration_assign_to_complete_ms,
    tokens?.input ?? null, tokens?.output ?? null, tokens?.cache_read ?? null, tokens?.cache_creation ?? null, tokens?.total ?? null,
    now
  );

  return {
    id,
    task_id: taskId,
    section,
    title,
    success: args.success,
    tokens_total: tokens?.total ?? null,
    duration_assign_to_complete_ms,
  };
}

function getWorklog(args: GetWorklogArgs): GetWorklogResult {
  const worklogDb = getWorklogDb();
  const hours = args.hours ?? 24;
  const limit = args.limit ?? 20;
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  let sql = 'SELECT * FROM worklog_entries WHERE created_at >= ?';
  const params: unknown[] = [since];

  if (args.category_id) {
    sql += ' AND category_id = ?';
    params.push(args.category_id);
  } else if (args.section) {
    sql += ' AND section = ?';
    params.push(args.section);
  }

  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  interface WorklogRow {
    id: string;
    task_id: string;
    session_id: string | null;
    agent_id: string | null;
    section: string;
    title: string;
    assigned_by: string | null;
    summary: string;
    success: number;
    timestamp_assigned: string | null;
    timestamp_started: string | null;
    timestamp_completed: string;
    duration_assign_to_start_ms: number | null;
    duration_start_to_complete_ms: number | null;
    duration_assign_to_complete_ms: number | null;
    tokens_input: number | null;
    tokens_output: number | null;
    tokens_cache_read: number | null;
    tokens_cache_creation: number | null;
    tokens_total: number | null;
    created_at: string;
  }

  const rows = worklogDb.prepare(sql).all(...params) as WorklogRow[];

  const entries: WorklogEntry[] = rows.map(row => ({
    ...row,
    success: row.success === 1,
  }));

  let metrics: WorklogMetrics | null = null;

  if (args.include_metrics !== false) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    interface MetricRow {
      total_entries: number;
      successful_entries: number;
      avg_assign_to_start: number | null;
      avg_start_to_complete: number | null;
      avg_assign_to_complete: number | null;
      avg_tokens: number | null;
      sum_cache_read: number | null;
      sum_input: number | null;
    }

    const metricRow = worklogDb.prepare(`
      SELECT
        COUNT(*) as total_entries,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successful_entries,
        AVG(duration_assign_to_start_ms) as avg_assign_to_start,
        AVG(duration_start_to_complete_ms) as avg_start_to_complete,
        AVG(duration_assign_to_complete_ms) as avg_assign_to_complete,
        AVG(tokens_total) as avg_tokens,
        SUM(tokens_cache_read) as sum_cache_read,
        SUM(tokens_input) as sum_input
      FROM worklog_entries
      WHERE created_at >= ?
    `).get(thirtyDaysAgo) as MetricRow;

    // Count completed tasks from todo.db for coverage
    const db = getDb();
    const thirtyDaysAgoTimestamp = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
    interface CountResult { count: number }
    const completedCount = (db.prepare(
      "SELECT COUNT(*) as count FROM tasks WHERE status = 'completed' AND completed_timestamp >= ?"
    ).get(thirtyDaysAgoTimestamp) as CountResult).count;

    const cacheHitPct = metricRow.sum_input && metricRow.sum_cache_read
      ? Math.round((metricRow.sum_cache_read / (metricRow.sum_input + metricRow.sum_cache_read)) * 1000) / 10
      : null;

    // Success rate: successful worklog entries / total worklog entries
    const successRatePct = metricRow.total_entries > 0
      ? Math.round(((metricRow.successful_entries ?? 0) / metricRow.total_entries) * 1000) / 10
      : null;

    metrics = {
      coverage_entries: metricRow.total_entries,
      coverage_completed_tasks: completedCount,
      coverage_pct: completedCount > 0 ? Math.min(100, Math.round((metricRow.total_entries / completedCount) * 1000) / 10) : 0,
      success_rate_pct: successRatePct,
      avg_time_to_start_ms: metricRow.avg_assign_to_start ? Math.round(metricRow.avg_assign_to_start) : null,
      avg_time_to_complete_from_start_ms: metricRow.avg_start_to_complete ? Math.round(metricRow.avg_start_to_complete) : null,
      avg_time_to_complete_from_assign_ms: metricRow.avg_assign_to_complete ? Math.round(metricRow.avg_assign_to_complete) : null,
      avg_tokens_per_task: metricRow.avg_tokens ? Math.round(metricRow.avg_tokens) : null,
      cache_hit_pct: cacheHitPct,
    };
  }

  return {
    entries,
    metrics,
    total: entries.length,
  };
}

function listArchivedTasks(args: ListArchivedTasksArgs): ListArchivedTasksResult {
  const db = getDb();
  const hours = args.hours ?? 24;
  const limit = args.limit ?? 20;
  const since = Math.floor((Date.now() - hours * 60 * 60 * 1000) / 1000);

  let sql = 'SELECT * FROM archived_tasks WHERE archived_timestamp >= ?';
  const params: unknown[] = [since];

  if (args.category_id) {
    sql += ' AND category_id = ?';
    params.push(args.category_id);
  } else if (args.section) {
    sql += ' AND section = ?';
    params.push(args.section);
  }

  sql += ' ORDER BY archived_timestamp DESC LIMIT ?';
  params.push(limit);

  const tasks = db.prepare(sql).all(...params) as ArchivedTask[];

  return {
    tasks,
    total: tasks.length,
  };
}

// ============================================================================
// Category Tool Implementations
// ============================================================================

function categoryToResponse(record: CategoryRecord): CategoryResponse | ErrorResult {
  let sequence: unknown[];
  try {
    sequence = JSON.parse(record.sequence);
  } catch {
    return { error: `Category '${record.id}' has corrupt sequence JSON` };
  }

  let creatorRestrictions: string[] | null = null;
  if (record.creator_restrictions) {
    try {
      creatorRestrictions = JSON.parse(record.creator_restrictions);
    } catch {
      return { error: `Category '${record.id}' has corrupt creator_restrictions JSON` };
    }
  }

  return {
    id: record.id,
    name: record.name,
    description: record.description,
    sequence: sequence as CategoryResponse['sequence'],
    prompt_template: record.prompt_template,
    model: record.model,
    creator_restrictions: creatorRestrictions,
    force_followup: record.force_followup === 1,
    urgency_authorized: record.urgency_authorized === 1,
    is_default: record.is_default === 1,
    deprecated_section: record.deprecated_section,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

function listCategories(args: ListCategoriesArgs): ListCategoriesResult {
  const db = getDb();
  const query = args.include_deprecated
    ? 'SELECT * FROM task_categories ORDER BY is_default DESC, name ASC'
    : 'SELECT * FROM task_categories WHERE deprecated_section IS NULL ORDER BY is_default DESC, name ASC';
  const rows = db.prepare(query).all() as CategoryRecord[];
  const categories = rows.map(categoryToResponse).filter((c): c is CategoryResponse => !('error' in c));
  return {
    categories,
    total: categories.length,
  };
}

function getCategory(args: GetCategoryArgs): CategoryResponse | ErrorResult {
  const db = getDb();
  const row = db.prepare('SELECT * FROM task_categories WHERE id = ?').get(args.id) as CategoryRecord | undefined;
  if (!row) {
    return { error: `Category not found: ${args.id}` };
  }
  return categoryToResponse(row); // may return ErrorResult if JSON is corrupt
}

function createCategory(args: CreateCategoryArgs): CategoryResponse | ErrorResult {
  const db = getDb();

  // Check for duplicate ID
  const existing = db.prepare('SELECT id FROM task_categories WHERE id = ?').get(args.id);
  if (existing) {
    return { error: `Category already exists: ${args.id}` };
  }

  const now = new Date().toISOString();
  const createTx = db.transaction(() => {
    // If setting as default, clear existing default within the same transaction
    if (args.is_default) {
      db.prepare('UPDATE task_categories SET is_default = 0 WHERE is_default = 1').run();
    }

    db.prepare(`
      INSERT INTO task_categories (id, name, description, sequence, prompt_template, model, creator_restrictions, force_followup, urgency_authorized, is_default, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      args.id,
      args.name,
      args.description ?? null,
      JSON.stringify(args.sequence),
      args.prompt_template ?? null,
      args.model ?? 'sonnet',
      args.creator_restrictions ? JSON.stringify(args.creator_restrictions) : null,
      args.force_followup ? 1 : 0,
      args.urgency_authorized !== false ? 1 : 0,
      args.is_default ? 1 : 0,
      now,
      now,
    );
  });
  createTx();

  const row = db.prepare('SELECT * FROM task_categories WHERE id = ?').get(args.id) as CategoryRecord;
  return categoryToResponse(row);
}

function updateCategory(args: UpdateCategoryArgs): CategoryResponse | ErrorResult {
  const db = getDb();

  const existing = db.prepare('SELECT * FROM task_categories WHERE id = ?').get(args.id) as CategoryRecord | undefined;
  if (!existing) {
    return { error: `Category not found: ${args.id}` };
  }

  const updates: string[] = ['updated_at = ?'];
  const values: (string | number | null)[] = [new Date().toISOString()];

  if (args.name !== undefined) {
    updates.push('name = ?');
    values.push(args.name);
  }
  if (args.description !== undefined) {
    updates.push('description = ?');
    values.push(args.description);
  }
  if (args.sequence !== undefined) {
    updates.push('sequence = ?');
    values.push(JSON.stringify(args.sequence));
  }
  if (args.prompt_template !== undefined) {
    updates.push('prompt_template = ?');
    values.push(args.prompt_template);
  }
  if (args.model !== undefined) {
    updates.push('model = ?');
    values.push(args.model);
  }
  if (args.creator_restrictions !== undefined) {
    updates.push('creator_restrictions = ?');
    values.push(args.creator_restrictions ? JSON.stringify(args.creator_restrictions) : null);
  }
  if (args.force_followup !== undefined) {
    updates.push('force_followup = ?');
    values.push(args.force_followup ? 1 : 0);
  }
  if (args.urgency_authorized !== undefined) {
    updates.push('urgency_authorized = ?');
    values.push(args.urgency_authorized ? 1 : 0);
  }
  if (args.is_default !== undefined) {
    updates.push('is_default = ?');
    values.push(args.is_default ? 1 : 0);
  }

  values.push(args.id);
  const updateTx = db.transaction(() => {
    // Clear existing default within same transaction to avoid orphaned state
    if (args.is_default) {
      db.prepare('UPDATE task_categories SET is_default = 0 WHERE is_default = 1').run();
    }
    db.prepare(`UPDATE task_categories SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  });
  updateTx();

  const row = db.prepare('SELECT * FROM task_categories WHERE id = ?').get(args.id) as CategoryRecord;
  return categoryToResponse(row);
}

function deleteCategory(args: DeleteCategoryArgs): { deleted: boolean; id: string } | ErrorResult {
  const db = getDb();

  const existing = db.prepare('SELECT * FROM task_categories WHERE id = ?').get(args.id) as CategoryRecord | undefined;
  if (!existing) {
    return { error: `Category not found: ${args.id}` };
  }

  // Block deletion if active tasks reference this category
  const activeTasks = db.prepare(
    "SELECT COUNT(*) as count FROM tasks WHERE category_id = ? AND status != 'completed'"
  ).get(args.id) as { count: number };
  if (activeTasks.count > 0) {
    return { error: `Cannot delete category '${args.id}': ${activeTasks.count} active task(s) reference it.` };
  }

  db.prepare('DELETE FROM task_categories WHERE id = ?').run(args.id);
  return { deleted: true, id: args.id };
}

// ============================================================================
// Gate Decision Tools
// ============================================================================

function gateApproveTask(args: { id: string }): object {
  const parsed = GateApproveTaskArgsSchema.parse(args);
  const db = getDb();
  const task = db.prepare('SELECT id, status, title FROM tasks WHERE id = ?').get(parsed.id) as { id: string; status: string; title: string } | undefined;
  if (!task) return { error: `Task not found: ${parsed.id}` };
  if (task.status !== 'pending_review') return { error: `Task is not in pending_review status (current: ${task.status}). Only pending_review tasks can be approved.` };

  db.prepare("UPDATE tasks SET status = 'pending' WHERE id = ?").run(parsed.id);
  return { id: parsed.id, title: task.title, old_status: 'pending_review', new_status: 'pending', message: 'Task approved and moved to pending queue.' };
}

function gateKillTask(args: { id: string; reason: string }): object {
  const parsed = GateKillTaskArgsSchema.parse(args);
  const db = getDb();
  const task = db.prepare('SELECT id, status, title FROM tasks WHERE id = ?').get(parsed.id) as { id: string; status: string; title: string } | undefined;
  if (!task) return { error: `Task not found: ${parsed.id}` };
  if (task.status !== 'pending_review') return { error: `Task is not in pending_review status (current: ${task.status}). Only pending_review tasks can be killed.` };

  db.prepare('DELETE FROM tasks WHERE id = ?').run(parsed.id);
  return { id: parsed.id, title: task.title, killed: true, reason: parsed.reason, message: `Task killed: ${parsed.reason}` };
}

function gateEscalateTask(args: { id: string; reason: string }): object {
  const parsed = GateEscalateTaskArgsSchema.parse(args);
  const db = getDb();
  const task = db.prepare('SELECT id, status, title, description, assigned_by, metadata FROM tasks WHERE id = ?').get(parsed.id) as { id: string; status: string; title: string; description: string | null; assigned_by: string | null; metadata: string | null } | undefined;
  if (!task) return { error: `Task not found: ${parsed.id}` };
  if (task.status !== 'pending_review') return { error: `Task is not in pending_review status (current: ${task.status}). Only pending_review tasks can be escalated.` };

  // Approve and store escalation reason atomically
  let existingMeta: Record<string, unknown> = {};
  try { if (task.metadata) existingMeta = JSON.parse(task.metadata as string); } catch { /* ignore */ }
  const mergedMeta = JSON.stringify({ ...existingMeta, gate_escalation: { reason: parsed.reason, escalated_at: new Date().toISOString() } });
  db.prepare("UPDATE tasks SET status = 'pending', metadata = ? WHERE id = ?").run(mergedMeta, parsed.id);

  return {
    id: parsed.id,
    title: task.title,
    old_status: 'pending_review',
    new_status: 'pending',
    escalated: true,
    reason: parsed.reason,
    message: `Task approved and escalated. Escalation reason stored in task metadata for deputy-CTO review.`,
  };
}

// ============================================================================
// Server Setup
// ============================================================================

// ============================================================================
// Audit Gate Handlers
// ============================================================================

function updateTaskGate(args: UpdateTaskGateArgs): object {
  const db = getDb();
  const task = db.prepare('SELECT id, status, gate_status FROM tasks WHERE id = ?').get(args.task_id) as { id: string; status: string; gate_status: string | null } | undefined;
  if (!task) return { error: `Task not found: ${args.task_id}` };
  if (task.status === 'completed' || task.status === 'pending_audit') {
    return { error: `Cannot update gate on a task with status '${task.status}'` };
  }

  const updates: string[] = [];
  const values: unknown[] = [];
  if (args.success_criteria) { updates.push('gate_success_criteria = ?'); values.push(args.success_criteria); }
  if (args.verification_method) { updates.push('gate_verification_method = ?'); values.push(args.verification_method); }
  if (args.reset_to_draft) {
    updates.push("gate_status = 'draft'", 'gate_confirmed_at = NULL', 'gate_confirmed_by = NULL');
  } else if (!task.gate_status) {
    updates.push("gate_status = 'draft'");
  }
  if (updates.length === 0) return { error: 'No fields to update' };

  values.push(args.task_id);
  db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  const updated = db.prepare('SELECT gate_success_criteria, gate_verification_method, gate_status, gate_confirmed_at FROM tasks WHERE id = ?').get(args.task_id) as Record<string, unknown>;
  return { task_id: args.task_id, ...updated };
}

function confirmTaskGate(args: ConfirmTaskGateArgs): object {
  const db = getDb();
  const task = db.prepare('SELECT id, gate_status, gate_success_criteria, gate_verification_method FROM tasks WHERE id = ?').get(args.task_id) as { id: string; gate_status: string | null; gate_success_criteria: string | null; gate_verification_method: string | null } | undefined;
  if (!task) return { error: `Task not found: ${args.task_id}` };
  if (!task.gate_status) return { error: `No gate defined on this task. Call update_task_gate first.` };
  if (task.gate_status === 'active') return { task_id: args.task_id, gate_status: 'active', warning: 'Gate already confirmed' };

  const now = new Date().toISOString();
  const agentId = process.env.CLAUDE_AGENT_ID ?? 'unknown';
  const criteria = args.refined_success_criteria ?? task.gate_success_criteria;
  const method = args.refined_verification_method ?? task.gate_verification_method;

  db.prepare(`UPDATE tasks SET gate_status = 'active', gate_confirmed_at = ?, gate_confirmed_by = ?, gate_success_criteria = ?, gate_verification_method = ? WHERE id = ?`)
    .run(now, agentId, criteria, method, args.task_id);

  return {
    task_id: args.task_id,
    gate_status: 'active',
    gate_confirmed_at: now,
    success_criteria: criteria,
    verification_method: method,
    alignment_session_id: args.alignment_session_id ?? null,
  };
}

function checkTaskAudit(args: CheckTaskAuditArgs): object {
  const db = getDb();
  const audit = db.prepare('SELECT * FROM task_audits WHERE task_id = ? ORDER BY attempt_number DESC LIMIT 1').get(args.task_id) as Record<string, unknown> | undefined;
  if (!audit) return { task_id: args.task_id, audit_status: 'not_applicable' };
  return {
    task_id: args.task_id,
    audit_status: audit.verdict === null ? 'pending' : audit.verdict,
    verdict: audit.verdict,
    evidence: audit.evidence,
    failure_reason: audit.failure_reason,
    requested_at: audit.requested_at,
    completed_at: audit.completed_at,
    attempt_number: audit.attempt_number,
    auditor_agent_id: audit.auditor_agent_id,
  };
}

function taskAuditPass(args: TaskAuditPassArgs): object {
  const db = getDb();
  const task = db.prepare('SELECT id, status, followup_enabled, followup_section, followup_prompt, section, category_id FROM tasks WHERE id = ?').get(args.task_id) as TaskRecord | undefined;
  if (!task) return { error: `Task not found: ${args.task_id}` };
  if (task.status !== 'pending_audit') return { error: `Task is not in pending_audit status (current: ${task.status})` };

  const audit = db.prepare('SELECT id FROM task_audits WHERE task_id = ? AND verdict IS NULL ORDER BY attempt_number DESC LIMIT 1').get(args.task_id) as { id: string } | undefined;
  if (!audit) return { error: `No pending audit found for task: ${args.task_id}` };

  const now = new Date();
  const completed_at = now.toISOString();
  const completed_timestamp = Math.floor(now.getTime() / 1000);
  const agentId = process.env.CLAUDE_AGENT_ID ?? 'unknown';

  const txn = db.transaction(() => {
    db.prepare("UPDATE task_audits SET verdict = 'pass', evidence = ?, completed_at = ?, auditor_agent_id = ? WHERE id = ?")
      .run(args.evidence, completed_at, agentId, audit.id);
    db.prepare("UPDATE tasks SET status = 'completed', completed_at = ?, completed_timestamp = ? WHERE id = ?")
      .run(completed_at, completed_timestamp, args.task_id);

    // Trigger follow-up if enabled
    let followup_task_id: string | undefined;
    if (task.followup_enabled) {
      const followupId = randomUUID();
      const section = task.followup_section ?? task.section;
      db.prepare(`INSERT INTO tasks (id, section, category_id, status, title, description, assigned_by, created_at, created_timestamp, followup_enabled) VALUES (?, ?, ?, 'pending', ?, ?, 'system-followup', ?, ?, 0)`)
        .run(followupId, section, task.category_id ?? null, `[Follow-up] ${task.title}`, task.followup_prompt, completed_at, completed_timestamp);
      followup_task_id = followupId;
    }
    return followup_task_id;
  });

  const followup_task_id = txn();

  return { task_id: args.task_id, status: 'completed', verdict: 'pass', evidence: args.evidence, completed_at, followup_task_id };
}

function taskAuditFail(args: TaskAuditFailArgs): object {
  const db = getDb();
  const task = db.prepare('SELECT id, status FROM tasks WHERE id = ?').get(args.task_id) as { id: string; status: string } | undefined;
  if (!task) return { error: `Task not found: ${args.task_id}` };
  if (task.status !== 'pending_audit') return { error: `Task is not in pending_audit status (current: ${task.status})` };

  const audit = db.prepare('SELECT id FROM task_audits WHERE task_id = ? AND verdict IS NULL ORDER BY attempt_number DESC LIMIT 1').get(args.task_id) as { id: string } | undefined;
  if (!audit) return { error: `No pending audit found for task: ${args.task_id}` };

  const now = new Date().toISOString();
  const agentId = process.env.CLAUDE_AGENT_ID ?? 'unknown';

  db.transaction(() => {
    db.prepare("UPDATE task_audits SET verdict = 'fail', failure_reason = ?, evidence = ?, completed_at = ?, auditor_agent_id = ? WHERE id = ?")
      .run(args.failure_reason, args.evidence, now, agentId, audit.id);
    db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?")
      .run(args.task_id);
  })();

  return { task_id: args.task_id, status: 'in_progress', verdict: 'fail', failure_reason: args.failure_reason, evidence: args.evidence };
}

const tools: AnyToolHandler[] = [
  {
    name: 'list_tasks',
    description: 'List tasks with optional filters. Agents should filter by their section.',
    schema: ListTasksArgsSchema,
    handler: listTasks,
  },
  {
    name: 'get_task',
    description: 'Get a single task by ID.',
    schema: GetTaskArgsSchema,
    handler: getTask,
  },
  {
    name: 'create_task',
    description: 'Create a new task. Restricted sections (e.g., DEPUTY-CTO) require assigned_by to match allowed creators. Tasks created by deputy-cto always have follow-up verification enabled.',
    schema: CreateTaskArgsSchema,
    handler: createTask,
  },
  {
    name: 'start_task',
    description: 'Mark a task as in-progress. MUST be called before beginning work on a task.',
    schema: StartTaskArgsSchema,
    handler: startTask,
  },
  {
    name: 'complete_task',
    description: 'Mark a task as completed. Records completion timestamp.',
    schema: CompleteTaskArgsSchema,
    handler: completeTask,
  },
  {
    name: 'delete_task',
    description: 'Delete a task by ID.',
    schema: DeleteTaskArgsSchema,
    handler: deleteTask,
  },
  {
    name: 'get_summary',
    description: 'Get task counts by section and status.',
    schema: GetSummaryArgsSchema,
    handler: getSummary,
  },
  {
    name: 'cleanup',
    description: 'Run cleanup logic: reset stale starts (>30 min), archive old completed (>3 hrs), cap at 50 completed, prune archives (>30 days & >500).',
    schema: CleanupArgsSchema,
    handler: cleanup,
  },
  {
    name: 'get_sessions_for_task',
    description: 'Get ALL candidate sessions that may have completed a task. Returns sessions within 5-minute window of completion time. Agent should explore candidates with browse_session to identify the correct one.',
    schema: GetSessionsForTaskArgsSchema,
    handler: getSessionsForTask,
  },
  {
    name: 'browse_session',
    description: 'Browse a Claude session transcript. Use after get_sessions_for_task to find the session that completed the work.',
    schema: BrowseSessionArgsSchema,
    handler: browseSession,
  },
  {
    name: 'get_completed_since',
    description: 'Get count of tasks completed within a time range, grouped by section. Useful for CTO reports and metrics.',
    schema: GetCompletedSinceArgsSchema,
    handler: getCompletedSince,
  },
  {
    name: 'summarize_work',
    description: 'Record a worklog entry for a completed task. Call this BEFORE complete_task to capture task metrics. Auto-resolves task_id from CLAUDE_AGENT_ID env when omitted.',
    schema: SummarizeWorkArgsSchema,
    handler: summarizeWork,
  },
  {
    name: 'get_worklog',
    description: 'Get recent worklog entries with optional 30-day rolling metrics (coverage, avg duration, avg tokens, cache hit rate).',
    schema: GetWorklogArgsSchema,
    handler: getWorklog,
  },
  {
    name: 'list_archived_tasks',
    description: 'List archived (previously completed) tasks. Useful for audit history. Tasks are archived automatically by cleanup or when deleted after completion.',
    schema: ListArchivedTasksArgsSchema,
    handler: listArchivedTasks,
  },
  {
    name: 'list_categories',
    description: 'List task categories. Categories define agent sequences (workflows) for tasks.',
    schema: ListCategoriesArgsSchema,
    handler: listCategories,
  },
  {
    name: 'get_category',
    description: 'Get a task category by ID. Returns the full category including its agent sequence and prompt template.',
    schema: GetCategoryArgsSchema,
    handler: getCategory,
  },
  {
    name: 'create_category',
    description: 'Create a new task category with an agent sequence. Categories define the workflow (ordered list of agents) that tasks follow.',
    schema: CreateCategoryArgsSchema,
    handler: createCategory,
  },
  {
    name: 'update_category',
    description: 'Update a task category. Patch semantics — only provided fields are updated. Cannot change deprecated_section.',
    schema: UpdateCategoryArgsSchema,
    handler: updateCategory,
  },
  {
    name: 'delete_category',
    description: 'Delete a task category. Blocked if any active (non-completed) tasks reference it.',
    schema: DeleteCategoryArgsSchema,
    handler: deleteCategory,
  },
  {
    name: 'gate_approve_task',
    description: 'Approve a pending_review task, moving it to pending status for spawning. Only works on pending_review tasks.',
    schema: GateApproveTaskArgsSchema,
    handler: gateApproveTask,
  },
  {
    name: 'gate_kill_task',
    description: 'Kill a pending_review task with a reason. Deletes the task entirely. Only works on pending_review tasks.',
    schema: GateKillTaskArgsSchema,
    handler: gateKillTask,
  },
  {
    name: 'gate_escalate_task',
    description: 'Approve AND escalate a pending_review task. Moves to pending status and stores escalation reason in metadata for deputy-CTO review.',
    schema: GateEscalateTaskArgsSchema,
    handler: gateEscalateTask,
  },
  {
    name: 'update_task_gate',
    description: 'Set or update audit gate criteria on a task. Defines what success looks like and how to verify it. The task will be independently audited against these criteria before completion is accepted.',
    schema: UpdateTaskGateArgsSchema,
    handler: updateTaskGate,
  },
  {
    name: 'confirm_task_gate',
    description: 'Confirm a draft gate definition after user-alignment review. Transitions gate from draft to active, making the task spawnable. Call after running a user-alignment sub-agent to validate the gate criteria.',
    schema: ConfirmTaskGateArgsSchema,
    handler: confirmTaskGate,
  },
  {
    name: 'check_task_audit',
    description: 'Check the audit status of a task in pending_audit. Returns verdict (pending/pass/fail), evidence, and attempt number.',
    schema: CheckTaskAuditArgsSchema,
    handler: checkTaskAudit,
  },
  {
    name: 'task_audit_pass',
    description: 'Mark a task audit as passed. Transitions task from pending_audit to completed. Called by the universal-auditor agent after verifying success criteria are met.',
    schema: TaskAuditPassArgsSchema,
    handler: taskAuditPass,
  },
  {
    name: 'task_audit_fail',
    description: 'Mark a task audit as failed. Transitions task from pending_audit back to in_progress with failure reason. The agent must address the failure and re-attempt completion.',
    schema: TaskAuditFailArgsSchema,
    handler: taskAuditFail,
  },
];

const server = new McpServer({
  name: 'todo-db',
  version: '2.0.0',
  tools,
});

// Handle cleanup on exit
process.on('SIGINT', () => {
  closeWorklogDb();
  closeDb();
  process.exit(0);
});

process.on('SIGTERM', () => {
  closeWorklogDb();
  closeDb();
  process.exit(0);
});

server.start();
