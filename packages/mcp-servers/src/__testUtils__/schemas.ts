/**
 * Database Schema Constants for MCP Server Tests
 *
 * Single source of truth for database schemas used in tests.
 * These schemas mirror the production schemas in each server's server.ts file.
 *
 * IMPORTANT: Keep these in sync with the actual server implementations!
 *
 * @module __testUtils__/schemas
 */

// ============================================================================
// TODO Database Schema
// ============================================================================

/**
 * Schema for the todo-db MCP server.
 * Mirrors: packages/mcp-servers/src/todo-db/server.ts
 */
export const TODO_DB_SCHEMA = `
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
    CONSTRAINT valid_status CHECK (status IN ('pending', 'in_progress', 'completed')),
    CONSTRAINT valid_section CHECK (section IN ('TEST-WRITER', 'INVESTIGATOR & PLANNER', 'CODE-REVIEWER', 'PROJECT-MANAGER'))
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
// Deputy-CTO Database Schema
// ============================================================================

/**
 * Schema for the deputy-cto MCP server.
 * Mirrors: packages/mcp-servers/src/deputy-cto/server.ts
 */
export const DEPUTY_CTO_SCHEMA = `
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
// Agent Reports Database Schema
// ============================================================================

/**
 * Schema for the agent-reports MCP server.
 * Mirrors: packages/mcp-servers/src/agent-reports/server.ts
 *
 * Note: This server was formerly called cto-reports.
 */
export const AGENT_REPORTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    reporting_agent TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'other',
    priority TEXT NOT NULL DEFAULT 'normal',
    created_at TEXT NOT NULL,
    created_timestamp INTEGER NOT NULL,
    read_at TEXT,
    acknowledged_at TEXT,
    -- Triage lifecycle fields
    triage_status TEXT NOT NULL DEFAULT 'pending',
    triage_started_at TEXT,
    triage_completed_at TEXT,
    triage_session_id TEXT,
    triage_outcome TEXT,
    triage_attempted_at TEXT,
    -- Legacy fields (for backward compatibility)
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
`;

// ============================================================================
// Shared Constants
// ============================================================================

/**
 * Valid task sections for todo-db.
 * Should match VALID_SECTIONS in shared/constants.ts
 */
export const VALID_SECTIONS = [
  'TEST-WRITER',
  'INVESTIGATOR & PLANNER',
  'CODE-REVIEWER',
  'PROJECT-MANAGER',
] as const;

export type ValidSection = (typeof VALID_SECTIONS)[number];

/**
 * Valid task statuses.
 */
export const TASK_STATUS = ['pending', 'in_progress', 'completed'] as const;

export type TaskStatus = (typeof TASK_STATUS)[number];

/**
 * Valid report categories.
 */
export const REPORT_CATEGORIES = [
  'architecture',
  'security',
  'performance',
  'breaking-change',
  'blocker',
  'decision',
  'user-feedback',
  'other',
] as const;

export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

/**
 * Valid report priorities.
 */
export const REPORT_PRIORITIES = ['low', 'normal', 'high', 'critical'] as const;

export type ReportPriority = (typeof REPORT_PRIORITIES)[number];

/**
 * Valid triage statuses.
 */
export const TRIAGE_STATUS = [
  'pending',
  'in_progress',
  'self_handled',
  'escalated',
  'dismissed',
] as const;

export type TriageStatus = (typeof TRIAGE_STATUS)[number];

/**
 * Valid question types for deputy-cto.
 */
export const QUESTION_TYPES = [
  'decision',
  'approval',
  'rejection',
  'question',
  'escalation',
  'bypass-request',
] as const;

export type QuestionType = (typeof QUESTION_TYPES)[number];

// ============================================================================
// User Feedback Database Schema
// ============================================================================

/**
 * Schema for the user-feedback MCP server.
 * Mirrors: packages/mcp-servers/src/user-feedback/server.ts
 */
export const USER_FEEDBACK_SCHEMA = `
CREATE TABLE IF NOT EXISTS personas (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    consumption_mode TEXT NOT NULL DEFAULT 'gui',
    behavior_traits TEXT NOT NULL DEFAULT '[]',
    endpoints TEXT NOT NULL DEFAULT '[]',
    credentials_ref TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    created_timestamp INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    CONSTRAINT valid_mode CHECK (consumption_mode IN ('gui', 'cli', 'api', 'sdk'))
);

CREATE INDEX IF NOT EXISTS idx_personas_mode ON personas(consumption_mode);
CREATE INDEX IF NOT EXISTS idx_personas_enabled ON personas(enabled);

CREATE TABLE IF NOT EXISTS features (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    file_patterns TEXT NOT NULL DEFAULT '[]',
    url_patterns TEXT NOT NULL DEFAULT '[]',
    category TEXT,
    created_at TEXT NOT NULL,
    created_timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_features_category ON features(category);

CREATE TABLE IF NOT EXISTS persona_features (
    persona_id TEXT NOT NULL,
    feature_id TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal',
    test_scenarios TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (persona_id, feature_id),
    FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE CASCADE,
    FOREIGN KEY (feature_id) REFERENCES features(id) ON DELETE CASCADE,
    CONSTRAINT valid_priority CHECK (priority IN ('low', 'normal', 'high', 'critical'))
);

CREATE TABLE IF NOT EXISTS feedback_runs (
    id TEXT PRIMARY KEY,
    trigger_type TEXT NOT NULL,
    trigger_ref TEXT,
    changed_features TEXT NOT NULL DEFAULT '[]',
    personas_triggered TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending',
    max_concurrent INTEGER NOT NULL DEFAULT 3,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    summary TEXT,
    CONSTRAINT valid_status CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'partial'))
);

CREATE INDEX IF NOT EXISTS idx_runs_status ON feedback_runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_started ON feedback_runs(started_at);

CREATE TABLE IF NOT EXISTS feedback_sessions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    persona_id TEXT NOT NULL,
    agent_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    started_at TEXT,
    completed_at TEXT,
    findings_count INTEGER DEFAULT 0,
    report_ids TEXT DEFAULT '[]',
    satisfaction_level TEXT,
    CONSTRAINT valid_status CHECK (status IN ('pending', 'queued', 'running', 'completed', 'failed', 'timeout')),
    FOREIGN KEY (run_id) REFERENCES feedback_runs(id),
    FOREIGN KEY (persona_id) REFERENCES personas(id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_run ON feedback_sessions(run_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON feedback_sessions(status);
`;

/**
 * Valid consumption modes for personas.
 */
export const CONSUMPTION_MODES = ['gui', 'cli', 'api', 'sdk'] as const;

export type ConsumptionMode = (typeof CONSUMPTION_MODES)[number];

/**
 * Valid feature priorities.
 */
export const FEATURE_PRIORITIES = ['low', 'normal', 'high', 'critical'] as const;

export type FeaturePriority = (typeof FEATURE_PRIORITIES)[number];

/**
 * Valid feedback run statuses.
 */
export const FEEDBACK_RUN_STATUSES = ['pending', 'in_progress', 'completed', 'failed', 'partial'] as const;

export type FeedbackRunStatus = (typeof FEEDBACK_RUN_STATUSES)[number];

/**
 * Valid feedback session statuses.
 */
export const FEEDBACK_SESSION_STATUSES = ['pending', 'queued', 'running', 'completed', 'failed', 'timeout'] as const;

export type FeedbackSessionStatus = (typeof FEEDBACK_SESSION_STATUSES)[number];
