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
  VALID_SECTIONS,
  SECTION_CREATOR_RESTRICTIONS,
  FORCED_FOLLOWUP_CREATORS,
  type ListTasksArgs,
  type GetTaskArgs,
  type CreateTaskArgs,
  type StartTaskArgs,
  type CompleteTaskArgs,
  type DeleteTaskArgs,
  type GetSessionsForTaskArgs,
  type BrowseSessionArgs,
  type GetCompletedSinceArgs,
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
} from './types.js';

// ============================================================================
// Configuration
// ============================================================================

const PROJECT_DIR = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const DB_PATH = path.join(PROJECT_DIR, '.claude', 'todo.db');
const SESSION_WINDOW_MINUTES = 5;

// ============================================================================
// Database Schema
// ============================================================================

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    section TEXT NOT NULL,
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
    followup_enabled INTEGER NOT NULL DEFAULT 0,
    followup_section TEXT,
    followup_prompt TEXT,
    priority TEXT NOT NULL DEFAULT 'normal',
    CONSTRAINT valid_status CHECK (status IN ('pending', 'in_progress', 'completed')),
    CONSTRAINT valid_section CHECK (section IN ('TEST-WRITER', 'INVESTIGATOR & PLANNER', 'CODE-REVIEWER', 'PROJECT-MANAGER', 'DEPUTY-CTO', 'PRODUCT-MANAGER')),
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
    db.exec(`INSERT INTO tasks (id, section, status, title, description, created_at, started_at, completed_at, assigned_by, metadata, created_timestamp, completed_timestamp, followup_enabled, followup_section, followup_prompt) SELECT id, section, status, title, description, created_at, started_at, completed_at, assigned_by, metadata, created_timestamp, completed_timestamp, COALESCE(followup_enabled, 0), followup_section, followup_prompt FROM tasks_old`);
    db.exec("DROP TABLE tasks_old");
  }

  // Auto-migration: add priority column if missing (existing databases)
  try {
    db.prepare("SELECT priority FROM tasks LIMIT 0").run();
  } catch {
    db.exec("ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'");
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

function taskToResponse(task: TaskRecord): TaskResponse {
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
// Tool Implementations
// ============================================================================

function listTasks(args: ListTasksArgs): ListTasksResult {
  const db = getDb();
  let sql = 'SELECT * FROM tasks WHERE 1=1';
  const params: unknown[] = [];

  if (args.section) {
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

  if (!(VALID_SECTIONS as readonly string[]).includes(args.section)) {
    return { error: `Invalid section: ${args.section}. Must be one of: ${VALID_SECTIONS.join(', ')}` };
  }

  // Soft access control
  const restrictions = SECTION_CREATOR_RESTRICTIONS[args.section as ValidSection];
  if (restrictions) {
    if (!args.assigned_by || !restrictions.includes(args.assigned_by)) {
      const gotValue = args.assigned_by ?? '(none)';
      return {
        error: `Section '${args.section}' requires assigned_by to be one of: ${restrictions.join(', ')}. Got: '${gotValue}'`,
      };
    }
  }

  // Follow-up enforcement for forced creators
  let followup_enabled = args.followup_enabled ?? false;
  let followup_section = args.followup_section ?? args.section;
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

  const id = randomUUID();
  const now = new Date();
  const created_at = now.toISOString();
  const created_timestamp = Math.floor(now.getTime() / 1000);

  const priority = args.priority ?? 'normal';

  db.prepare(`
    INSERT INTO tasks (id, section, status, title, description, assigned_by, created_at, created_timestamp, followup_enabled, followup_section, followup_prompt, priority)
    VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, args.section, args.title, args.description ?? null, args.assigned_by ?? null, created_at, created_timestamp, followup_enabled ? 1 : 0, followup_section, followup_prompt, priority);

  return {
    id,
    section: args.section,
    status: 'pending',
    title: args.title,
    description: args.description ?? null,
    created_at,
    started_at: null,
    completed_at: null,
    assigned_by: args.assigned_by ?? null,
    followup_enabled,
    priority: priority as TaskPriority,
    warning,
  };
}

function startTask(args: StartTaskArgs): StartTaskResult | ErrorResult {
  const db = getDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(args.id) as TaskRecord | undefined;

  if (!task) {
    return { error: `Task not found: ${args.id}` };
  }

  if (task.status === 'completed') {
    return { error: `Task already completed: ${args.id}` };
  }

  if (task.status === 'in_progress') {
    return { error: `Task already in progress: ${args.id}` };
  }

  const now = new Date();
  const started_at = now.toISOString();

  db.prepare(`
    UPDATE tasks SET status = 'in_progress', started_at = ?
    WHERE id = ?
  `).run(started_at, args.id);

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

  const now = new Date();
  const completed_at = now.toISOString();
  const completed_timestamp = Math.floor(now.getTime() / 1000);

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
      INSERT INTO tasks (id, section, status, title, description, assigned_by, created_at, created_timestamp, followup_enabled, followup_section, followup_prompt)
      VALUES (?, ?, 'pending', ?, ?, 'system-followup', ?, ?, 0, NULL, NULL)
    `).run(followupId, section, title, description, followup_created_at, followup_timestamp);

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

  db.prepare('DELETE FROM tasks WHERE id = ?').run(args.id);

  return {
    deleted: true,
    id: args.id,
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
  };

  // Initialize all sections
  for (const section of VALID_SECTIONS) {
    result.by_section[section] = { pending: 0, in_progress: 0, completed: 0 };
  }

  interface CountRow {
    section: string;
    status: string;
    count: number;
  }

  const tasks = db.prepare('SELECT section, status, COUNT(*) as count FROM tasks GROUP BY section, status').all() as CountRow[];

  for (const row of tasks) {
    result.total += row.count;
    result[row.status as keyof Pick<SummaryResult, 'pending' | 'in_progress' | 'completed'>] += row.count;
    if (result.by_section[row.section]) {
      (result.by_section[row.section] as SectionStats)[row.status as keyof SectionStats] = row.count;
    }
  }

  return result;
}

function cleanup(): CleanupResult {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const changes = {
    stale_starts_cleared: 0,
    old_completed_removed: 0,
    completed_capped: 0,
  };

  // Clear stale starts (>30 min without completion)
  const staleResult = db.prepare(`
    UPDATE tasks
    SET status = 'pending', started_at = NULL
    WHERE status = 'in_progress'
      AND started_at IS NOT NULL
      AND (? - created_timestamp) > 1800
  `).run(now);
  changes.stale_starts_cleared = staleResult.changes;

  // Remove completed tasks older than 3 hours
  const oldResult = db.prepare(`
    DELETE FROM tasks
    WHERE status = 'completed'
      AND completed_timestamp IS NOT NULL
      AND (? - completed_timestamp) > 10800
  `).run(now);
  changes.old_completed_removed = oldResult.changes;

  // Cap completed tasks at 50 (keep most recent)
  interface CountResult { count: number }
  const completedCount = (db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'completed'").get() as CountResult).count;
  if (completedCount > 50) {
    const toRemove = completedCount - 50;
    const capResult = db.prepare(`
      DELETE FROM tasks WHERE id IN (
        SELECT id FROM tasks
        WHERE status = 'completed'
        ORDER BY completed_timestamp ASC
        LIMIT ?
      )
    `).run(toRemove);
    changes.completed_capped = capResult.changes;
  }

  return {
    ...changes,
    message: `Cleanup complete: ${changes.stale_starts_cleared} stale starts cleared, ${changes.old_completed_removed} old completed removed, ${changes.completed_capped} completed capped`,
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
  const completionTime = task.completed_timestamp * 1000; // Convert to ms

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
    section: string;
    count: number;
  }

  const rows = db.prepare(`
    SELECT section, COUNT(*) as count
    FROM tasks
    WHERE status = 'completed' AND completed_timestamp >= ?
    GROUP BY section
    ORDER BY count DESC
  `).all(sinceTimestamp) as CountRow[];

  const total = rows.reduce((sum, row) => sum + row.count, 0);

  return {
    hours,
    since: new Date(since).toISOString(),
    total,
    by_section: rows,
  };
}

// ============================================================================
// Server Setup
// ============================================================================

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
    description: 'Run cleanup logic: remove stale starts (>30 min), old completed (>3 hrs), cap at 50 completed.',
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
];

const server = new McpServer({
  name: 'todo-db',
  version: '2.0.0',
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
