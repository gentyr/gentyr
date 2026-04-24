/**
 * Shared data interfaces for the live CTO dashboard.
 */

// ============================================================================
// Session List
// ============================================================================

export type SessionStatus = 'alive' | 'queued' | 'spawning' | 'suspended' | 'paused' | 'completed' | 'failed' | 'killed';
export type SessionPriority = 'cto' | 'critical' | 'urgent' | 'normal' | 'low';

export interface SessionItem {
  id: string;
  status: SessionStatus;
  priority: SessionPriority;
  agentType: string;
  title: string;
  pid: number | null;
  lastAction: string | null;       // e.g., "Edit src/tabs.ts"
  lastActionTimestamp: string;      // ISO — age computed at render
  lastMessage: string | null;      // most recent assistant text snippet
  description: string | null;      // task prompt/description (for queued items)
  killReason: string | null;
  totalTokens: number | null;
  sessionId: string | null;         // queue ID or agent ID
  elapsed: string;                  // total run time
  startedAt: string | null;         // ISO — spawned_at or enqueued_at
  completedAt: string | null;       // ISO — completed_at (null if running/resumed)
  /** Only for completed sessions with worklog */
  worklog: WorklogEntry | null;
  /** Worktree path from queue DB — used to find session JSONL in worktree dirs */
  worktreePath: string | null;
}

export interface WorklogEntry {
  summary: string;
  success: boolean;
  durationMs: number | null;
  tokens: number | null;
}

export interface PersistentTaskItem {
  id: string;
  title: string;
  status: string;                   // active, paused, completed, etc.
  age: string;
  cycleCount: number;
  heartbeatAge: string;
  heartbeatStale: boolean;
  demoInvolved: boolean;
  strictInfraGuidance: boolean;
  monitorSession: SessionItem;      // the monitor session (selectable)
  subTasks: SubTaskItem[];
}

export interface SubTaskItem {
  id: string;
  title: string;
  status: string;                   // completed, in_progress, pending
  section: string;
  /** If in_progress with a running agent, this is a selectable session */
  session: SessionItem | null;
  agentStage: string | null;
  agentProgressPct: number | null;
  prUrl: string | null;
  prMerged: boolean;
  worklog: WorklogEntry | null;
}

// ============================================================================
// Session List Display
// ============================================================================

/** Wrapper for rendering sessions with hierarchy (indent for PT children) */
export interface DisplaySession {
  session: SessionItem;
  indent: number;            // 0 = top-level, 1 = child of persistent task
  isMonitor: boolean;        // true for persistent task monitor sessions
  persistentTaskTitle?: string; // PT title for monitor sessions
}

// ============================================================================
// Activity Stream
// ============================================================================

export interface ActivityEntry {
  type: 'tool_call' | 'assistant_text' | 'tool_result' | 'error' | 'compaction' | 'session_end' | 'user_message';
  timestamp: string;
  text: string;
  toolName?: string;
  toolInput?: string;
  resultPreview?: string;
}

// ============================================================================
// Unified Dashboard Data
// ============================================================================

export interface LiveDashboardData {
  queuedSessions: SessionItem[];
  persistentTasks: PersistentTaskItem[];
  runningSessions: SessionItem[];       // non-persistent running sessions
  suspendedSessions: SessionItem[];
  completedSessions: SessionItem[];
  capacity: { running: number; max: number };
}

// ============================================================================
// Page Navigation
// ============================================================================

export type PageId = 1 | 2 | 3 | 4 | 5;

// ============================================================================
// Page 5: Live AI Commentary Feed
// ============================================================================

export interface FeedMessage {
  id: string;
  text: string;
  timestamp: string;   // ISO
  tokensUsed: number;
}

export interface Page5Data {
  messages: FeedMessage[];
  streamingText: string;          // partial text currently being generated
  isGenerating: boolean;
  lastGeneratedAt: string | null; // ISO
  error: string | null;
}

export interface CommentaryContextSession {
  agentType: string;
  title: string;
  lastTool: string | null;
  lastMessage: string | null;
}

export interface CommentaryContextPlan {
  title: string;
  status: string;
  progressPct: number;
  currentPhase: string | null;
}

export interface CommentaryContextSummary {
  title: string;
  summary: string;
}

export interface CommentaryContext {
  sessions: CommentaryContextSession[];
  recentSummaries: CommentaryContextSummary[];
  projectSummary: string | null;
  plans: CommentaryContextPlan[];
}

// ============================================================================
// Page 2: Demos & Tests
// ============================================================================

export interface DemoScenarioItem {
  id: string;
  personaId: string;
  personaName: string;
  title: string;
  description: string;
  category: string | null;
  playwrightProject: string;
  testFile: string;
  sortOrder: number;
  enabled: boolean;
  headed: boolean;
  lastRecordedAt: string | null;
  recordingPath: string | null;
  envVars: Record<string, string> | null;
}

export type TestRunner = 'playwright' | 'vitest' | 'jest';

export interface TestFileItem {
  project: string;            // playwright project name or vitest config group
  filePath: string;           // relative to project root
  fileName: string;           // basename
  isDemo: boolean;            // .demo.ts vs .spec.ts (playwright only)
  runner: TestRunner;
}

export type ProcessStatus = 'running' | 'passed' | 'failed';

export interface RunningProcess {
  pid: number;
  label: string;
  type: 'demo' | 'test';
  status: ProcessStatus;
  startedAt: string;
  outputFile: string;
  exitCode: number | null;
}

export interface Page2Data {
  scenarios: DemoScenarioItem[];
  testFiles: TestFileItem[];
}

// ============================================================================
// Page 3: Plans
// ============================================================================

export interface PlanSubstepItem {
  id: string;
  title: string;
  completed: boolean;
}

export interface PlanAuditInfo {
  verdict: 'pass' | 'fail' | null;  // null = pending
  evidence: string | null;
  failureReason: string | null;
  attemptNumber: number;
  requestedAt: string;
  completedAt: string | null;
  verificationStrategy: string;
}

export interface PlanTaskItem {
  id: string;
  title: string;
  status: string;             // pending, ready, in_progress, pending_audit, completed, skipped, blocked
  agentType: string | null;
  categoryId: string | null;
  prNumber: number | null;
  prMerged: boolean;
  persistentTaskId: string | null;
  substeps: PlanSubstepItem[];
  substepProgress: string;    // "3/5"
  progressPct: number;
  blockedBy: string[];        // titles of blocking tasks
  auditInfo: PlanAuditInfo | null;
}

export interface PlanPhaseItem {
  id: string;
  title: string;
  phaseOrder: number;
  status: string;
  progressPct: number;
  tasks: PlanTaskItem[];
}

export interface PlanItem {
  id: string;
  title: string;
  status: string;
  progressPct: number;
  phaseCount: number;
  taskCount: number;
  completedTasks: number;
  readyTasks: number;
  activeTasks: number;
  currentPhase: string | null;
  updatedAt: string | null;
  managerPid: number | null;
  managerAlive: boolean;
}

export interface PlanStateChange {
  label: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  changedAt: string;
}

export interface Page3Data {
  plans: PlanItem[];
  planDetail: { planId: string; phases: PlanPhaseItem[] } | null;
  recentChanges: PlanStateChange[];
}

// ============================================================================
// Page 4: Specs
// ============================================================================

export interface SpecItem {
  specId: string;             // filename without .md
  title: string;
  ruleId: string | null;
  severity: string | null;
  category: string;
  filePath: string;
}

export interface SpecCategoryItem {
  key: string;
  description: string;
  source: 'framework' | 'project';
  specs: SpecItem[];
}

export interface SuiteItem {
  id: string;
  description: string;
  scope: string;
  enabled: boolean;
}

export interface Page4Data {
  categories: SpecCategoryItem[];
  suites: SuiteItem[];
  totalSpecs: number;
  selectedSpecContent: string | null;
}
