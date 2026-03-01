/**
 * Test Data Fixtures for MCP Server Tests
 *
 * Factory functions for creating test data with sensible defaults.
 * Use these to reduce boilerplate in tests and ensure consistent test data.
 *
 * @module __testUtils__/fixtures
 */

import { randomUUID } from 'crypto';
import type {
  ValidSection,
  TaskStatus,
  ReportCategory,
  ReportPriority,
  TriageStatus,
  QuestionType,
  FeaturePriority,
} from './schemas.js';

// ============================================================================
// Task Fixtures (todo-db)
// ============================================================================

export interface TaskFixture {
  id: string;
  section: ValidSection;
  status: TaskStatus;
  title: string;
  description: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  assigned_by: string | null;
  metadata: string | null;
  created_timestamp: number;
  completed_timestamp: number | null;
}

/**
 * Creates a task fixture with sensible defaults.
 *
 * @example
 * ```typescript
 * const task = createTask();
 * const completedTask = createTask({ status: 'completed' });
 * const reviewTask = createTask({ section: 'CODE-REVIEWER', title: 'Review PR' });
 * ```
 */
export function createTask(overrides: Partial<TaskFixture> = {}): TaskFixture {
  const now = new Date();
  const created_timestamp = Math.floor(now.getTime() / 1000);

  return {
    id: randomUUID(),
    section: 'TEST-WRITER',
    status: 'pending',
    title: 'Test task',
    description: null,
    created_at: now.toISOString(),
    started_at: null,
    completed_at: null,
    assigned_by: null,
    metadata: null,
    created_timestamp,
    completed_timestamp: null,
    ...overrides,
  };
}

/**
 * Creates a task that is currently in progress.
 */
export function createInProgressTask(overrides: Partial<TaskFixture> = {}): TaskFixture {
  const now = new Date();
  return createTask({
    status: 'in_progress',
    started_at: now.toISOString(),
    ...overrides,
  });
}

/**
 * Creates a completed task.
 */
export function createCompletedTask(overrides: Partial<TaskFixture> = {}): TaskFixture {
  const now = new Date();
  const completed_timestamp = Math.floor(now.getTime() / 1000);
  return createTask({
    status: 'completed',
    started_at: now.toISOString(),
    completed_at: now.toISOString(),
    completed_timestamp,
    ...overrides,
  });
}

// ============================================================================
// Report Fixtures (agent-reports)
// ============================================================================

export interface ReportFixture {
  id: string;
  reporting_agent: string;
  title: string;
  summary: string;
  category: ReportCategory;
  priority: ReportPriority;
  created_at: string;
  created_timestamp: number;
  read_at: string | null;
  acknowledged_at: string | null;
  triage_status: TriageStatus;
  triage_started_at: string | null;
  triage_completed_at: string | null;
  triage_session_id: string | null;
  triage_outcome: string | null;
  triage_attempted_at: string | null;
  triaged_at: string | null;
  triage_action: string | null;
}

/**
 * Creates a report fixture with sensible defaults.
 *
 * @example
 * ```typescript
 * const report = createReport();
 * const criticalReport = createReport({ priority: 'critical' });
 * const securityReport = createReport({ category: 'security', title: 'SQL injection' });
 * ```
 */
export function createReport(overrides: Partial<ReportFixture> = {}): ReportFixture {
  const now = new Date();
  const created_timestamp = Math.floor(now.getTime() / 1000);

  return {
    id: randomUUID(),
    reporting_agent: 'test-agent',
    title: 'Test report',
    summary: 'Test summary for the report',
    category: 'other',
    priority: 'normal',
    created_at: now.toISOString(),
    created_timestamp,
    read_at: null,
    acknowledged_at: null,
    triage_status: 'pending',
    triage_started_at: null,
    triage_completed_at: null,
    triage_session_id: null,
    triage_outcome: null,
    triage_attempted_at: null,
    triaged_at: null,
    triage_action: null,
    ...overrides,
  };
}

/**
 * Creates a read report.
 */
export function createReadReport(overrides: Partial<ReportFixture> = {}): ReportFixture {
  const now = new Date();
  return createReport({
    read_at: now.toISOString(),
    ...overrides,
  });
}

/**
 * Creates an acknowledged report.
 */
export function createAcknowledgedReport(overrides: Partial<ReportFixture> = {}): ReportFixture {
  const now = new Date();
  return createReport({
    read_at: now.toISOString(),
    acknowledged_at: now.toISOString(),
    ...overrides,
  });
}

/**
 * Creates a triaged report.
 */
export function createTriagedReport(
  status: 'self_handled' | 'escalated' | 'dismissed' = 'self_handled',
  overrides: Partial<ReportFixture> = {}
): ReportFixture {
  const now = new Date();
  return createReport({
    read_at: now.toISOString(),
    acknowledged_at: now.toISOString(),
    triage_status: status,
    triage_completed_at: now.toISOString(),
    triage_outcome: `Report was ${status}`,
    triaged_at: now.toISOString(),
    ...overrides,
  });
}

// ============================================================================
// Question Fixtures (deputy-cto)
// ============================================================================

export interface QuestionFixture {
  id: string;
  type: QuestionType;
  status: 'pending' | 'answered';
  title: string;
  description: string;
  context: string | null;
  suggested_options: string | null;
  answer: string | null;
  created_at: string;
  created_timestamp: number;
  answered_at: string | null;
  decided_by: 'cto' | 'deputy-cto' | null;
}

/**
 * Creates a question fixture with sensible defaults.
 *
 * @example
 * ```typescript
 * const question = createQuestion();
 * const approvalQuestion = createQuestion({ type: 'approval' });
 * const answeredQuestion = createQuestion({ status: 'answered', answer: 'Yes' });
 * ```
 */
export function createQuestion(overrides: Partial<QuestionFixture> = {}): QuestionFixture {
  const now = new Date();
  const created_timestamp = Math.floor(now.getTime() / 1000);

  return {
    id: randomUUID(),
    type: 'decision',
    status: 'pending',
    title: 'Test question',
    description: 'Test description for the question',
    context: null,
    suggested_options: null,
    answer: null,
    created_at: now.toISOString(),
    created_timestamp,
    answered_at: null,
    decided_by: null,
    ...overrides,
  };
}

/**
 * Creates an answered question.
 */
export function createAnsweredQuestion(
  answer: string = 'Approved',
  overrides: Partial<QuestionFixture> = {}
): QuestionFixture {
  const now = new Date();
  return createQuestion({
    status: 'answered',
    answer,
    answered_at: now.toISOString(),
    decided_by: 'cto',
    ...overrides,
  });
}

/**
 * Creates a rejection question (blocks commits).
 */
export function createRejectionQuestion(
  overrides: Partial<QuestionFixture> = {}
): QuestionFixture {
  return createQuestion({
    type: 'rejection',
    title: 'Commit rejection',
    description: 'Security issue found in commit',
    ...overrides,
  });
}

// ============================================================================
// Commit Decision Fixtures (deputy-cto)
// ============================================================================

export interface CommitDecisionFixture {
  id: string;
  decision: 'approved' | 'rejected';
  rationale: string;
  question_id: string | null;
  created_at: string;
  created_timestamp: number;
}

/**
 * Creates a commit decision fixture.
 */
export function createCommitDecision(
  decision: 'approved' | 'rejected' = 'approved',
  overrides: Partial<CommitDecisionFixture> = {}
): CommitDecisionFixture {
  const now = new Date();
  const created_timestamp = Math.floor(now.getTime() / 1000);

  return {
    id: randomUUID(),
    decision,
    rationale: decision === 'approved' ? 'Changes look good' : 'Security issue found',
    question_id: null,
    created_at: now.toISOString(),
    created_timestamp,
    ...overrides,
  };
}

// ============================================================================
// Batch Creation Helpers
// ============================================================================

/**
 * Creates multiple tasks.
 */
export function createTasks(count: number, overrides: Partial<TaskFixture> = {}): TaskFixture[] {
  return Array.from({ length: count }, (_, i) =>
    createTask({
      title: `Task ${i + 1}`,
      created_timestamp: Math.floor(Date.now() / 1000) + i, // Stagger timestamps
      ...overrides,
    })
  );
}

/**
 * Creates multiple reports.
 */
export function createReports(
  count: number,
  overrides: Partial<ReportFixture> = {}
): ReportFixture[] {
  return Array.from({ length: count }, (_, i) =>
    createReport({
      title: `Report ${i + 1}`,
      created_timestamp: Math.floor(Date.now() / 1000) + i, // Stagger timestamps
      ...overrides,
    })
  );
}

/**
 * Creates multiple questions.
 */
export function createQuestions(
  count: number,
  overrides: Partial<QuestionFixture> = {}
): QuestionFixture[] {
  return Array.from({ length: count }, (_, i) =>
    createQuestion({
      title: `Question ${i + 1}`,
      created_timestamp: Math.floor(Date.now() / 1000) + i, // Stagger timestamps
      ...overrides,
    })
  );
}

// ============================================================================
// Database Insert Helpers
// ============================================================================

import type Database from 'better-sqlite3';

/**
 * Inserts a task into the database.
 */
export function insertTask(db: Database.Database, task: TaskFixture): void {
  db.prepare(`
    INSERT INTO tasks (
      id, section, status, title, description, created_at, started_at,
      completed_at, assigned_by, metadata, created_timestamp, completed_timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    task.id,
    task.section,
    task.status,
    task.title,
    task.description,
    task.created_at,
    task.started_at,
    task.completed_at,
    task.assigned_by,
    task.metadata,
    task.created_timestamp,
    task.completed_timestamp
  );
}

/**
 * Inserts multiple tasks into the database.
 */
export function insertTasks(db: Database.Database, tasks: TaskFixture[]): void {
  for (const task of tasks) {
    insertTask(db, task);
  }
}

/**
 * Inserts a report into the database.
 */
export function insertReport(db: Database.Database, report: ReportFixture): void {
  db.prepare(`
    INSERT INTO reports (
      id, reporting_agent, title, summary, category, priority, created_at,
      created_timestamp, read_at, acknowledged_at, triage_status, triage_started_at,
      triage_completed_at, triage_session_id, triage_outcome, triage_attempted_at,
      triaged_at, triage_action
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    report.id,
    report.reporting_agent,
    report.title,
    report.summary,
    report.category,
    report.priority,
    report.created_at,
    report.created_timestamp,
    report.read_at,
    report.acknowledged_at,
    report.triage_status,
    report.triage_started_at,
    report.triage_completed_at,
    report.triage_session_id,
    report.triage_outcome,
    report.triage_attempted_at,
    report.triaged_at,
    report.triage_action
  );
}

/**
 * Inserts multiple reports into the database.
 */
export function insertReports(db: Database.Database, reports: ReportFixture[]): void {
  for (const report of reports) {
    insertReport(db, report);
  }
}

/**
 * Inserts a question into the database.
 */
export function insertQuestion(db: Database.Database, question: QuestionFixture): void {
  db.prepare(`
    INSERT INTO questions (
      id, type, status, title, description, context, suggested_options,
      answer, created_at, created_timestamp, answered_at, decided_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    question.id,
    question.type,
    question.status,
    question.title,
    question.description,
    question.context,
    question.suggested_options,
    question.answer,
    question.created_at,
    question.created_timestamp,
    question.answered_at,
    question.decided_by
  );
}

/**
 * Inserts multiple questions into the database.
 */
export function insertQuestions(db: Database.Database, questions: QuestionFixture[]): void {
  for (const question of questions) {
    insertQuestion(db, question);
  }
}

/**
 * Inserts a commit decision into the database.
 */
export function insertCommitDecision(
  db: Database.Database,
  decision: CommitDecisionFixture
): void {
  db.prepare(`
    INSERT INTO commit_decisions (
      id, decision, rationale, question_id, created_at, created_timestamp
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    decision.id,
    decision.decision,
    decision.rationale,
    decision.question_id,
    decision.created_at,
    decision.created_timestamp
  );
}

// ============================================================================
// Persona Fixtures (user-feedback)
// ============================================================================

export interface PersonaFixture {
  id: string;
  name: string;
  description: string;
  consumption_modes: string; // JSON array
  behavior_traits: string;
  endpoints: string;
  credentials_ref: string | null;
  enabled: number;
  created_at: string;
  created_timestamp: number;
  updated_at: string;
}

/**
 * Creates a persona fixture with sensible defaults.
 */
export function createPersonaFixture(overrides: Partial<PersonaFixture> = {}): PersonaFixture {
  const now = new Date();
  const created_timestamp = Math.floor(now.getTime() / 1000);

  return {
    id: randomUUID(),
    name: 'test-persona',
    description: 'A test persona',
    consumption_modes: '["gui"]',
    behavior_traits: '[]',
    endpoints: '[]',
    credentials_ref: null,
    enabled: 1,
    created_at: now.toISOString(),
    created_timestamp,
    updated_at: now.toISOString(),
    ...overrides,
  };
}

/**
 * Inserts a persona into the database.
 */
export function insertPersonaFixture(db: Database.Database, persona: PersonaFixture): void {
  db.prepare(`
    INSERT INTO personas (
      id, name, description, consumption_modes, behavior_traits, endpoints,
      credentials_ref, enabled, created_at, created_timestamp, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    persona.id,
    persona.name,
    persona.description,
    persona.consumption_modes,
    persona.behavior_traits,
    persona.endpoints,
    persona.credentials_ref,
    persona.enabled,
    persona.created_at,
    persona.created_timestamp,
    persona.updated_at
  );
}

// ============================================================================
// Feature Fixtures (user-feedback)
// ============================================================================

export interface FeatureFixture {
  id: string;
  name: string;
  description: string | null;
  file_patterns: string;
  url_patterns: string;
  category: string | null;
  created_at: string;
  created_timestamp: number;
}

/**
 * Creates a feature fixture with sensible defaults.
 */
export function createFeatureFixture(overrides: Partial<FeatureFixture> = {}): FeatureFixture {
  const now = new Date();
  const created_timestamp = Math.floor(now.getTime() / 1000);

  return {
    id: randomUUID(),
    name: 'test-feature',
    description: null,
    file_patterns: JSON.stringify(['src/**']),
    url_patterns: '[]',
    category: null,
    created_at: now.toISOString(),
    created_timestamp,
    ...overrides,
  };
}

/**
 * Inserts a feature into the database.
 */
export function insertFeatureFixture(db: Database.Database, feature: FeatureFixture): void {
  db.prepare(`
    INSERT INTO features (
      id, name, description, file_patterns, url_patterns, category,
      created_at, created_timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    feature.id,
    feature.name,
    feature.description,
    feature.file_patterns,
    feature.url_patterns,
    feature.category,
    feature.created_at,
    feature.created_timestamp
  );
}

/**
 * Inserts a persona-feature mapping.
 */
export function insertPersonaFeatureMapping(
  db: Database.Database,
  args: {
    persona_id: string;
    feature_id: string;
    priority?: FeaturePriority;
    test_scenarios?: string[];
  }
): void {
  db.prepare(`
    INSERT INTO persona_features (persona_id, feature_id, priority, test_scenarios)
    VALUES (?, ?, ?, ?)
  `).run(
    args.persona_id,
    args.feature_id,
    args.priority ?? 'normal',
    JSON.stringify(args.test_scenarios ?? [])
  );
}
