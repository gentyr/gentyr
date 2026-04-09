/**
 * Shared data interfaces for the live CTO dashboard.
 */

// ============================================================================
// Session List (Page 1 left panel)
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
// Right Panel Widgets (Page 1)
// ============================================================================

export interface QuotaData {
  fiveHourPct: number;
  sevenDayPct: number;
}

export interface DeputyCtoSummary {
  untriagedCount: number;
  escalatedCount: number;
  pendingQuestionCount: number;
  handled24h: number;
  dismissed24h: number;
}

export interface SystemStatusData {
  deputyEnabled: boolean;
  deputyIntervalMinutes: number;
  protectionStatus: string;
  commitsBlocked: boolean;
}

export interface PlanItem {
  id: string;
  title: string;
  status: string;
  progressPct: number;
  completedTasks: number;
  totalTasks: number;
  readyTasks: number;
}

export interface MetricsSummaryData {
  tokensIn: number;
  tokensOut: number;
  cacheRate: number;
  tasksPending: number;
  tasksActive: number;
  tasksDone24h: number;
  hooksTotal: number;
  hooksSuccessRate: number;
  triagePending: number;
  triageHandled24h: number;
  cooldownFactor: number;
  cooldownTargetPct: number;
}

export interface WorklogMetrics {
  successRatePct: number | null;
  avgCompleteMs: number | null;
  coveragePct: number;
  cacheHitPct: number | null;
  entries: number;
  completedTasks: number;
}

// ============================================================================
// Page 2: Intelligence
// ============================================================================

export interface DeputyCtoDetail {
  hasData: boolean;
  untriaged: TriageReport[];
  escalated: TriageReport[];
  recentlyTriaged: TriageReport[];
  pendingQuestions: PendingQuestion[];
  answeredQuestions: AnsweredQuestion[];
  handled24h: number;
  escalated24h: number;
  dismissed24h: number;
}

export interface TriageReport {
  id: string;
  title: string;
  priority: string;
  status: string;
  createdAt: string;
  outcome?: string;
}

export interface PendingQuestion {
  id: string;
  title: string;
  type: string;
  createdAt: string;
  recommendation: string | null;
}

export interface AnsweredQuestion {
  id: string;
  title: string;
  answer: string;
  createdAt: string;
}

export interface FeedbackPersona {
  name: string;
  consumptionModes: string;
  enabled: boolean;
  sessionCount: number;
  lastSatisfaction: string | null;
  findingsCount: number;
}

export interface WorklogEntryDetail {
  id: string;
  section: string;
  title: string;
  success: boolean;
  durationMs: number | null;
  tokens: number | null;
  createdAt: string;
}

export interface Page2Data {
  deputyCto: DeputyCtoDetail;
  personas: FeedbackPersona[];
  productManagerEnabled: boolean;
  productManagerSectionsCompleted: number;
  worklogEntries: WorklogEntryDetail[];
  worklogMetrics: WorklogMetrics;
}

// ============================================================================
// Page 3: Infrastructure
// ============================================================================

export interface TimelineEvent {
  type: 'hook' | 'report' | 'question' | 'task' | 'session';
  timestamp: Date;
  title: string;
  subtitle?: string;
  priority?: string;
}

export interface TestingData {
  hasData: boolean;
  totalTests: number;
  passing: number;
  failing: number;
  skipped: number;
  coveragePct: number | null;
}

export interface DeploymentItem {
  service: string;
  environment: string;
  status: string;
  timestamp: string;
}

export interface WorktreeInfo {
  branch: string;
  path: string;
  age: string;
  hasChanges: boolean;
}

export interface InfraStatus {
  renderServices: number;
  renderSuspended: number;
  vercelProjects: number;
  supabaseHealthy: boolean;
  cloudflareStatus: string;
}

export interface LoggingData {
  totalLogs1h: number;
  totalLogs24h: number;
  errorCount1h: number;
  warnCount1h: number;
}

export interface Page3Data {
  testing: TestingData;
  deployments: DeploymentItem[];
  worktrees: WorktreeInfo[];
  infra: InfraStatus;
  logging: LoggingData;
  timeline: TimelineEvent[];
}

// ============================================================================
// Page Analytics (Usage + Automations)
// ============================================================================

export interface UsageSnapshot {
  timestamp: string;
  utilization: number;
}

export interface UsageData {
  hasData: boolean;
  fiveHourSnapshots: UsageSnapshot[];
  sevenDaySnapshots: UsageSnapshot[];
  cooldownFactor: number;
  targetPct: number;
  projectedAtResetPct: number | null;
}

export interface AutomatedInstance {
  type: string;
  count: number;
  tokensTotal: number;
}

export interface PageAnalyticsData {
  usage: UsageData;
  automatedInstances: AutomatedInstance[];
}

// ============================================================================
// Page 4: Observe (Session Tail / Signal)
// ============================================================================

export interface ActivityEntry {
  type: 'tool_call' | 'assistant_text' | 'tool_result' | 'error' | 'compaction';
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
  // Page 1
  queuedSessions: SessionItem[];
  persistentTasks: PersistentTaskItem[];
  runningSessions: SessionItem[];       // non-persistent running sessions
  suspendedSessions: SessionItem[];
  completedSessions: SessionItem[];
  capacity: { running: number; max: number };
  quota: QuotaData;
  deputyCtoSummary: DeputyCtoSummary;
  systemStatus: SystemStatusData;
  plans: PlanItem[];
  metricsSummary: MetricsSummaryData;
  worklogMetrics: WorklogMetrics;
  // Page 2
  page2: Page2Data;
  // Page 3 (infra)
  page3: Page3Data;
  // Page 3 analytics (usage + automations)
  pageAnalytics: PageAnalyticsData;
}
