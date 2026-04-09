/**
 * Comprehensive mock data for the live CTO dashboard.
 * All timestamps are relative to Date.now() for fresh-looking renders.
 */

import type {
  LiveDashboardData, SessionItem, PersistentTaskItem, SubTaskItem,
  WorklogEntry, QuotaData, DeputyCtoSummary, SystemStatusData,
  PlanItem, MetricsSummaryData, WorklogMetrics,
  Page2Data, Page3Data, TimelineEvent,
} from './types.js';

function ago(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function mkSession(overrides: Partial<SessionItem> & { id: string; title: string; agentType: string }): SessionItem {
  return {
    status: 'alive',
    priority: 'normal',
    pid: null,
    lastAction: null,
    lastActionTimestamp: ago(1),
    lastMessage: null,
    description: null,
    killReason: null,
    totalTokens: null,
    sessionId: null,
    elapsed: '0s',
    worklog: null,
    worktreePath: null,
    ...overrides,
  };
}

function mkWorklog(summary: string, success: boolean, durationMs: number, tokens: number): WorklogEntry {
  return { summary, success, durationMs, tokens };
}

// ============================================================================
// Page 1: Session list + right panel
// ============================================================================

const queuedSessions: SessionItem[] = [
  mkSession({
    id: 'sq-q001',
    status: 'queued',
    priority: 'cto',
    agentType: 'code-reviewer',
    title: 'Review deployment pipeline changes',
    lastAction: null,
    lastActionTimestamp: ago(0.1),
    description: 'Review the changes to the CI/CD pipeline configuration in .github/workflows/ — verify caching, parallel jobs, and deploy conditions.',
    elapsed: '5s',
    sessionId: 'sq-q001',
  }),
  mkSession({
    id: 'sq-q002',
    status: 'queued',
    priority: 'urgent',
    agentType: 'investigator',
    title: 'Fix stale session detection in reaper',
    lastAction: null,
    lastActionTimestamp: ago(0.2),
    elapsed: '12s',
    sessionId: 'sq-q002',
  }),
  mkSession({
    id: 'sq-q003',
    status: 'queued',
    priority: 'normal',
    agentType: 'code-writer',
    title: 'Update changelog for v2.4 release',
    lastAction: null,
    lastActionTimestamp: ago(0.75),
    elapsed: '45s',
    sessionId: 'sq-q003',
  }),
];

const pt1MonitorSession = mkSession({
  id: 'pt1-monitor',
  status: 'alive',
  priority: 'critical',
  agentType: 'persistent-monitor',
  title: 'Monitor: AWS Demo E2E',
  pid: 42027,
  lastAction: 'mcp__todo-db__list_tasks',
  lastActionTimestamp: ago(2),
  totalTokens: 4_500_000,
  sessionId: 'agent-b62fe048-42027',
  elapsed: '2h 15m',
});

const pt1SubTasks: SubTaskItem[] = [
  {
    id: 'st-001',
    title: 'Register demo prerequisites',
    status: 'completed',
    section: 'DEMO-MANAGER',
    session: null,
    agentStage: null,
    agentProgressPct: null,
    prUrl: 'https://github.com/org/repo/pull/245',
    prMerged: true,
    worklog: mkWorklog(
      'Registered 3 global prerequisites: pnpm install, pnpm build, dev server health check. All health checks passing.',
      true, 83_000, 245_000,
    ),
  },
  {
    id: 'st-002',
    title: 'Run all demo scenarios headless',
    status: 'completed',
    section: 'DEMO-MANAGER',
    session: null,
    agentStage: null,
    agentProgressPct: null,
    prUrl: null,
    prMerged: false,
    worklog: mkWorklog(
      'All 4 demo scenarios passed in headless mode. Vendor onboarding (12s), dashboard tour (8s), settings flow (6s), API explorer (15s). Total 41s.',
      true, 252_000, 890_000,
    ),
  },
  {
    id: 'st-003',
    title: 'Fix tab switching in extension demo',
    status: 'in_progress',
    section: 'CODE-REVIEWER',
    session: mkSession({
      id: 'st-003-agent',
      status: 'alive',
      priority: 'normal',
      agentType: 'code-writer',
      title: 'Fix tab switching in extension demo',
      pid: 48419,
      lastAction: 'Edit tools/chrome-extension/extension/tabs.ts',
      lastActionTimestamp: ago(0.05),
      totalTokens: 450_000,
      sessionId: 'agent-mng6gbp4-48419',
      elapsed: '3m',
    }),
    agentStage: 'code-writer',
    agentProgressPct: 42,
    prUrl: null,
    prMerged: false,
    worklog: null,
  },
  {
    id: 'st-004',
    title: 'Update demo documentation',
    status: 'pending',
    section: 'CODE-REVIEWER',
    session: null,
    agentStage: null,
    agentProgressPct: null,
    prUrl: null,
    prMerged: false,
    worklog: null,
  },
  {
    id: 'st-005',
    title: 'Final validation - headed demo run',
    status: 'pending',
    section: 'DEMO-MANAGER',
    session: null,
    agentStage: null,
    agentProgressPct: null,
    prUrl: null,
    prMerged: false,
    worklog: null,
  },
];

const pt2MonitorSession = mkSession({
  id: 'pt2-monitor',
  status: 'alive',
  priority: 'critical',
  agentType: 'persistent-monitor',
  title: 'Monitor: Auth middleware refactor',
  pid: 91829,
  lastAction: 'mcp__persistent-task__get_persistent_task',
  lastActionTimestamp: ago(4),
  totalTokens: 2_100_000,
  sessionId: 'agent-a1b2c3d4-91829',
  elapsed: '45m',
});

const pt2SubTasks: SubTaskItem[] = [
  {
    id: 'st-010',
    title: 'Investigate session token storage',
    status: 'completed',
    section: 'INVESTIGATOR & PLANNER',
    session: null,
    agentStage: null,
    agentProgressPct: null,
    prUrl: null,
    prMerged: false,
    worklog: mkWorklog(
      'Identified 3 token storage locations that need migration: cookie store, Redis cache, and JWT payload. Documented migration path.',
      true, 420_000, 380_000,
    ),
  },
  {
    id: 'st-011',
    title: 'Implement new token encryption',
    status: 'in_progress',
    section: 'CODE-REVIEWER',
    session: mkSession({
      id: 'st-011-agent',
      status: 'alive',
      priority: 'normal',
      agentType: 'code-writer',
      title: 'Implement new token encryption',
      pid: 53637,
      lastAction: 'Bash npm test -- --filter=auth',
      lastActionTimestamp: ago(0.5),
      totalTokens: 620_000,
      sessionId: 'agent-xyz789-53637',
      elapsed: '12m',
    }),
    agentStage: 'test-writer',
    agentProgressPct: 68,
    prUrl: null,
    prMerged: false,
    worklog: null,
  },
  {
    id: 'st-012',
    title: 'Migration script for existing tokens',
    status: 'pending',
    section: 'CODE-REVIEWER',
    session: null,
    agentStage: null,
    agentProgressPct: null,
    prUrl: null,
    prMerged: false,
    worklog: null,
  },
];

const persistentTasks: PersistentTaskItem[] = [
  {
    id: 'pt-b33e3760',
    title: 'AWS Demo E2E',
    status: 'active',
    age: '2h 15m',
    cycleCount: 204,
    heartbeatAge: '2m',
    heartbeatStale: false,
    demoInvolved: true,
    strictInfraGuidance: false,
    monitorSession: pt1MonitorSession,
    subTasks: pt1SubTasks,
  },
  {
    id: 'pt-a1b2c3d4',
    title: 'Auth middleware refactor',
    status: 'active',
    age: '45m',
    cycleCount: 50,
    heartbeatAge: '4m',
    heartbeatStale: false,
    demoInvolved: false,
    strictInfraGuidance: true,
    monitorSession: pt2MonitorSession,
    subTasks: pt2SubTasks,
  },
];

const runningSessions: SessionItem[] = [
  mkSession({
    id: 'run-001',
    status: 'alive',
    priority: 'normal',
    agentType: 'test-writer',
    title: 'Add unit tests for session reaper',
    pid: 60123,
    lastAction: 'Write .claude/hooks/lib/__tests__/session-reaper.test.js',
    lastActionTimestamp: ago(0.3),
    totalTokens: 320_000,
    sessionId: 'agent-def456-60123',
    elapsed: '8m',
  }),
  mkSession({
    id: 'run-002',
    status: 'alive',
    priority: 'normal',
    agentType: 'gate-agent',
    title: 'Review task: Update API docs',
    pid: 60789,
    lastAction: 'mcp__todo-db__get_task',
    lastActionTimestamp: ago(0.05),
    totalTokens: 15_000,
    sessionId: 'agent-gate-60789',
    elapsed: '30s',
  }),
  mkSession({
    id: 'run-003',
    status: 'alive',
    priority: 'urgent',
    agentType: 'deputy-cto',
    title: 'Triage: Quota exhaustion report',
    pid: 61234,
    lastAction: 'mcp__agent-reports__read_report',
    lastActionTimestamp: ago(1),
    totalTokens: 180_000,
    sessionId: 'agent-dcto-61234',
    elapsed: '5m',
  }),
];

const suspendedSessions: SessionItem[] = [
  mkSession({
    id: 'sus-001',
    status: 'suspended',
    priority: 'low',
    agentType: 'code-writer',
    title: 'Refactor lint configuration',
    pid: 71234,
    lastAction: 'Edit .eslintrc.json',
    lastActionTimestamp: ago(45),
    totalTokens: 280_000,
    sessionId: 'agent-lint-71234',
    elapsed: '45m',
    killReason: 'preempted for CTO priority task',
  }),
];

const completedSessions: SessionItem[] = [
  mkSession({
    id: 'done-001',
    status: 'completed',
    priority: 'normal',
    agentType: 'code-writer',
    title: 'Fix auth middleware CORS headers',
    pid: null,
    lastAction: 'mcp__todo-db__summarize_work',
    lastActionTimestamp: ago(15),
    totalTokens: 1_200_000,
    sessionId: 'agent-auth-70001',
    elapsed: '12m 30s',
    worklog: mkWorklog(
      'Patched CORS headers in auth middleware to allow credentials from subdomain origins. Updated 3 files: middleware/cors.ts, config/allowed-origins.ts, tests/cors.test.ts. All 24 existing tests pass, added 6 new tests for subdomain scenarios.',
      true, 750_000, 1_200_000,
    ),
  }),
  mkSession({
    id: 'done-002',
    status: 'completed',
    priority: 'normal',
    agentType: 'code-writer',
    title: 'Update SDK TypeScript types',
    pid: null,
    lastAction: 'mcp__todo-db__summarize_work',
    lastActionTimestamp: ago(30),
    totalTokens: 890_000,
    sessionId: 'agent-sdk-70002',
    elapsed: '8m 45s',
    worklog: mkWorklog(
      'Regenerated TypeScript types from OpenAPI spec v2.4. Updated 12 type definition files, fixed 3 breaking changes in client SDK. Type check and all 156 tests pass.',
      true, 525_000, 890_000,
    ),
  }),
  mkSession({
    id: 'done-003',
    status: 'failed',
    priority: 'normal',
    agentType: 'demo-manager',
    title: 'Repair vendor onboarding demo',
    pid: null,
    lastAction: 'mcp__todo-db__summarize_work',
    lastActionTimestamp: ago(60),
    totalTokens: 450_000,
    sessionId: 'agent-demo-70003',
    elapsed: '15m',
    killReason: 'hard killed (60m limit)',
    worklog: mkWorklog(
      'Attempted to fix timeout in vendor onboarding demo step 3 (invoice upload). Root cause: dev server not starting due to missing env var. Created follow-up task.',
      false, 900_000, 450_000,
    ),
  }),
];

// ============================================================================
// Right panel widget data
// ============================================================================

const quota: QuotaData = {
  fiveHourPct: 28,
  sevenDayPct: 91,
};

const deputyCtoSummary: DeputyCtoSummary = {
  untriagedCount: 2,
  escalatedCount: 1,
  pendingQuestionCount: 3,
  handled24h: 15,
  dismissed24h: 4,
};

const systemStatus: SystemStatusData = {
  deputyEnabled: true,
  deputyIntervalMinutes: 15,
  protectionStatus: 'protected',
  commitsBlocked: false,
};

const plans: PlanItem[] = [
  { id: 'plan-001', title: 'SDK v2 API Migration', status: 'active', progressPct: 65, completedTasks: 13, totalTasks: 20, readyTasks: 3 },
  { id: 'plan-002', title: 'Auth Overhaul', status: 'active', progressPct: 30, completedTasks: 6, totalTasks: 20, readyTasks: 2 },
];

const metricsSummary: MetricsSummaryData = {
  tokensIn: 2_300_000,
  tokensOut: 450_000,
  cacheRate: 91,
  tasksPending: 3,
  tasksActive: 7,
  tasksDone24h: 42,
  hooksTotal: 156,
  hooksSuccessRate: 98,
  triagePending: 2,
  triageHandled24h: 15,
  cooldownFactor: 1.0,
  cooldownTargetPct: 80,
};

const worklogMetrics: WorklogMetrics = {
  successRatePct: 87,
  avgCompleteMs: 750_000,
  coveragePct: 82,
  cacheHitPct: 91,
  entries: 42,
  completedTasks: 51,
};

// ============================================================================
// Page 2 data
// ============================================================================

const page2Data: Page2Data = {
  deputyCto: {
    hasData: true,
    untriaged: [
      { id: 'r-001', title: 'Session reaper missing worktree cleanup', priority: 'high', status: 'pending', createdAt: ago(20) },
      { id: 'r-002', title: 'Gate agent timeout on large task descriptions', priority: 'normal', status: 'pending', createdAt: ago(45) },
    ],
    escalated: [
      { id: 'r-003', title: 'Auth token storage non-compliant with new policy', priority: 'critical', status: 'escalated', createdAt: ago(120), outcome: 'Escalated to CTO' },
    ],
    recentlyTriaged: [
      { id: 'r-010', title: 'Demo prerequisite health check flaky', priority: 'normal', status: 'self_handled', createdAt: ago(180), outcome: 'Spawned fix task' },
      { id: 'r-011', title: 'Worktree port allocation collision', priority: 'high', status: 'self_handled', createdAt: ago(240), outcome: 'Spawned investigation' },
      { id: 'r-012', title: 'Stale CSS in dashboard', priority: 'low', status: 'dismissed', createdAt: ago(300), outcome: 'Not reproducible' },
    ],
    pendingQuestions: [
      { id: 'q-001', title: 'Should we migrate Redis session store?', type: 'decision', createdAt: ago(30), recommendation: 'Yes - current implementation stores tokens in plaintext' },
      { id: 'q-002', title: 'Approve emergency hotfix for auth?', type: 'approval', createdAt: ago(15), recommendation: 'Approve - critical security fix' },
      { id: 'q-003', title: 'Increase max concurrent sessions to 15?', type: 'decision', createdAt: ago(60), recommendation: null },
    ],
    answeredQuestions: [
      { id: 'q-010', title: 'Deploy to production today?', answer: 'Yes, after staging passes', createdAt: ago(120) },
    ],
    handled24h: 15,
    escalated24h: 1,
    dismissed24h: 4,
  },
  personas: [
    { name: 'Power User Pete', consumptionModes: 'gui', enabled: true, sessionCount: 24, lastSatisfaction: 'satisfied', findingsCount: 3 },
    { name: 'API Dev Dana', consumptionModes: 'api', enabled: true, sessionCount: 18, lastSatisfaction: 'neutral', findingsCount: 7 },
    { name: 'CLI Chris', consumptionModes: 'cli', enabled: true, sessionCount: 12, lastSatisfaction: 'satisfied', findingsCount: 1 },
    { name: 'SDK Sam', consumptionModes: 'sdk', enabled: false, sessionCount: 6, lastSatisfaction: null, findingsCount: 0 },
  ],
  productManagerEnabled: true,
  productManagerSectionsCompleted: 4,
  worklogEntries: [
    { id: 'wl-001', section: 'CODE-REVIEWER', title: 'Fix auth CORS headers', success: true, durationMs: 750_000, tokens: 1_200_000, createdAt: ago(15) },
    { id: 'wl-002', section: 'CODE-REVIEWER', title: 'Update SDK types', success: true, durationMs: 525_000, tokens: 890_000, createdAt: ago(30) },
    { id: 'wl-003', section: 'DEMO-MANAGER', title: 'Repair vendor demo', success: false, durationMs: 900_000, tokens: 450_000, createdAt: ago(60) },
    { id: 'wl-004', section: 'DEPUTY-CTO', title: 'Triage quota report', success: true, durationMs: 180_000, tokens: 180_000, createdAt: ago(90) },
    { id: 'wl-005', section: 'TEST-WRITER', title: 'Session reaper tests', success: true, durationMs: 360_000, tokens: 320_000, createdAt: ago(120) },
    { id: 'wl-006', section: 'CODE-REVIEWER', title: 'Plan DB migration', success: true, durationMs: 420_000, tokens: 280_000, createdAt: ago(180) },
    { id: 'wl-007', section: 'INVESTIGATOR', title: 'Token storage analysis', success: true, durationMs: 420_000, tokens: 380_000, createdAt: ago(200) },
    { id: 'wl-008', section: 'DEMO-MANAGER', title: 'Register prerequisites', success: true, durationMs: 83_000, tokens: 245_000, createdAt: ago(240) },
    { id: 'wl-009', section: 'CODE-REVIEWER', title: 'Refactor port allocator', success: true, durationMs: 610_000, tokens: 520_000, createdAt: ago(300) },
    { id: 'wl-010', section: 'TEST-WRITER', title: 'Worktree cleanup tests', success: true, durationMs: 290_000, tokens: 210_000, createdAt: ago(360) },
    { id: 'wl-011', section: 'PROJECT-MANAGER', title: 'Merge feature/auth-cors', success: true, durationMs: 45_000, tokens: 35_000, createdAt: ago(420) },
    { id: 'wl-012', section: 'CODE-REVIEWER', title: 'Fix heartbeat detection', success: true, durationMs: 380_000, tokens: 310_000, createdAt: ago(480) },
    { id: 'wl-013', section: 'DEMO-MANAGER', title: 'Scaffold vendor demo', success: true, durationMs: 540_000, tokens: 670_000, createdAt: ago(540) },
    { id: 'wl-014', section: 'DEPUTY-CTO', title: 'Investigate stale gate', success: true, durationMs: 220_000, tokens: 190_000, createdAt: ago(600) },
    { id: 'wl-015', section: 'CODE-REVIEWER', title: 'Add display lock retry', success: false, durationMs: 720_000, tokens: 890_000, createdAt: ago(660) },
    { id: 'wl-016', section: 'TEST-WRITER', title: 'Resource lock unit tests', success: true, durationMs: 310_000, tokens: 260_000, createdAt: ago(720) },
    { id: 'wl-017', section: 'INVESTIGATOR', title: 'Analyze quota patterns', success: true, durationMs: 480_000, tokens: 410_000, createdAt: ago(780) },
    { id: 'wl-018', section: 'CODE-REVIEWER', title: 'Fix session signal race', success: true, durationMs: 560_000, tokens: 490_000, createdAt: ago(840) },
    { id: 'wl-019', section: 'DEMO-MANAGER', title: 'Dashboard tour scenario', success: true, durationMs: 650_000, tokens: 780_000, createdAt: ago(900) },
    { id: 'wl-020', section: 'PROJECT-MANAGER', title: 'Merge feature/signals', success: true, durationMs: 52_000, tokens: 28_000, createdAt: ago(960) },
  ],
  worklogMetrics: worklogMetrics,
};

// ============================================================================
// Page 3 data
// ============================================================================

const page3Data: Page3Data = {
  testing: {
    hasData: true,
    totalTests: 342,
    passing: 338,
    failing: 2,
    skipped: 2,
    coveragePct: 78,
  },
  deployments: [
    { service: 'web-app', environment: 'preview', status: 'success', timestamp: ago(5) },
    { service: 'web-app', environment: 'staging', status: 'success', timestamp: ago(30) },
    { service: 'api-server', environment: 'preview', status: 'success', timestamp: ago(45) },
    { service: 'api-server', environment: 'production', status: 'success', timestamp: ago(180) },
    { service: 'worker', environment: 'preview', status: 'failed', timestamp: ago(60) },
  ],
  worktrees: [
    { branch: 'feature/fix-tab-switching', path: '.claude/worktrees/fix-tab-switching', age: '3m', hasChanges: true },
    { branch: 'feature/token-encryption', path: '.claude/worktrees/token-encryption', age: '12m', hasChanges: true },
    { branch: 'feature/session-reaper-tests', path: '.claude/worktrees/session-reaper-tests', age: '8m', hasChanges: true },
    { branch: 'feature/lint-config', path: '.claude/worktrees/lint-config', age: '45m', hasChanges: false },
  ],
  infra: {
    renderServices: 3,
    renderSuspended: 0,
    vercelProjects: 2,
    supabaseHealthy: true,
    cloudflareStatus: 'active',
  },
  logging: {
    totalLogs1h: 12_450,
    totalLogs24h: 287_320,
    errorCount1h: 3,
    warnCount1h: 12,
  },
  timeline: [
    { type: 'session', timestamp: new Date(Date.now() - 2 * 60_000), title: 'Session spawned: code-writer for tab fix' },
    { type: 'task', timestamp: new Date(Date.now() - 5 * 60_000), title: 'PR #247 merged: auth CORS headers', subtitle: 'feature/auth-cors -> preview' },
    { type: 'task', timestamp: new Date(Date.now() - 15 * 60_000), title: 'Task completed: Fix auth middleware CORS headers' },
    { type: 'session', timestamp: new Date(Date.now() - 20 * 60_000), title: 'Demo passed: vendor onboarding (headless)' },
    { type: 'report', timestamp: new Date(Date.now() - 25 * 60_000), title: 'Report triaged: Demo prerequisite flaky', priority: 'normal' },
    { type: 'task', timestamp: new Date(Date.now() - 30 * 60_000), title: 'Task completed: Update SDK types' },
    { type: 'question', timestamp: new Date(Date.now() - 35 * 60_000), title: 'Question: Approve emergency hotfix for auth?', priority: 'high' },
    { type: 'hook', timestamp: new Date(Date.now() - 40 * 60_000), title: 'Hook: pre-commit-review blocked commit on stale branch' },
    { type: 'session', timestamp: new Date(Date.now() - 50 * 60_000), title: 'Session hard-killed: demo repair (60m limit)' },
    { type: 'report', timestamp: new Date(Date.now() - 60 * 60_000), title: 'Report: Auth token storage non-compliant', priority: 'critical' },
  ],
};

// ============================================================================
// Page Analytics data
// ============================================================================

const pageAnalyticsData: import('./types.js').PageAnalyticsData = {
  usage: {
    hasData: true,
    fiveHourSnapshots: Array.from({ length: 30 }, (_, i) => ({
      timestamp: new Date(Date.now() - (29 - i) * 10 * 60_000).toISOString(),
      utilization: Math.max(0, Math.min(100, 15 + Math.sin(i * 0.5) * 20 + i * 0.8)),
    })),
    sevenDaySnapshots: Array.from({ length: 42 }, (_, i) => ({
      timestamp: new Date(Date.now() - (41 - i) * 4 * 3600_000).toISOString(),
      utilization: Math.max(0, Math.min(100, 50 + Math.sin(i * 0.3) * 30 + (i > 30 ? 10 : 0))),
    })),
    cooldownFactor: 1.0,
    targetPct: 80,
    projectedAtResetPct: 72,
  },
  automatedInstances: [
    { type: 'code-writer', count: 42, tokensTotal: 12_500_000 },
    { type: 'test-writer', count: 28, tokensTotal: 8_200_000 },
    { type: 'code-reviewer', count: 35, tokensTotal: 9_800_000 },
    { type: 'demo-manager', count: 18, tokensTotal: 6_400_000 },
    { type: 'deputy-cto', count: 22, tokensTotal: 4_100_000 },
    { type: 'investigator', count: 15, tokensTotal: 3_600_000 },
    { type: 'gate-agent', count: 120, tokensTotal: 1_800_000 },
    { type: 'project-manager', count: 30, tokensTotal: 2_200_000 },
    { type: 'user-alignment', count: 12, tokensTotal: 2_900_000 },
    { type: 'persistent-monitor', count: 8, tokensTotal: 5_700_000 },
  ],
};

// ============================================================================
// Bulk generators for infinite scroll testing
// ============================================================================

const AGENT_TYPES = ['code-writer', 'test-writer', 'code-reviewer', 'demo-manager', 'deputy-cto', 'investigator', 'gate-agent', 'project-manager', 'persistent-monitor', 'user-alignment'];
const PRIORITIES: Array<SessionItem['priority']> = ['cto', 'critical', 'urgent', 'normal', 'normal', 'normal', 'normal', 'low'];
const ACTIONS = [
  'Edit src/auth/middleware.ts', 'Bash npm test', 'Read package.json', 'Write .env.local',
  'Grep "TODO" in src/', 'mcp__todo-db__list_tasks', 'mcp__agent-reports__read_report',
  'Edit e2e/demo/vendor.demo.ts', 'Bash git push origin HEAD', 'mcp__persistent-task__get',
  'Edit .claude/hooks/lib/session-queue.js', 'Bash pnpm build', 'Read tsconfig.json',
  'mcp__playwright__run_demo', 'Edit packages/mcp-servers/src/agent-tracker/server.ts',
  'Bash vitest run --filter=reaper', 'mcp__secret-sync__resolve', 'Edit src/components/App.tsx',
];
const TASK_TITLES = [
  'Fix CORS headers in auth middleware', 'Update SDK TypeScript types', 'Add session reaper unit tests',
  'Refactor port allocator', 'Fix heartbeat detection', 'Scaffold vendor demo', 'Investigate stale gate',
  'Add display lock retry logic', 'Resource lock unit tests', 'Analyze quota patterns',
  'Fix session signal race condition', 'Dashboard tour demo scenario', 'Merge feature/auth-cors',
  'Add caching layer for API responses', 'Rewrite console URLs to regional', 'Add diagnostic logging',
  'Post-revival verification run', 'Run AWS demo from main tree', 'Fix tab switching in extension',
  'Update demo documentation', 'Register demo prerequisites', 'Repair vendor onboarding demo',
  'Implement token encryption', 'Migration script for tokens', 'Fix branch checkout guard',
  'Update worktree provisioning', 'Fix stale CWD detection', 'Add PR auto-merge nudge',
  'Investigate quota exhaustion', 'Triage security report', 'Review deployment pipeline',
  'Fix eslint configuration', 'Update pre-commit hooks', 'Add feedback persona: CLI Chris',
  'Run demo validation suite', 'Fix window recorder SIGINT', 'Update plan orchestrator schema',
  'Add plan-merge-tracker hook', 'Fix session audit log cleanup', 'Implement focus mode guard',
  'Add reserved pool slots', 'Fix gate lane exemption', 'Update auth stall detection',
  'Implement inline preemption', 'Fix tombstone token swap', 'Add gateway error retry',
  'Update session audit trail', 'Fix MCP daemon health check', 'Add plugin system config',
  'Implement Notion sync daemon', 'Fix chrome extension permissions', 'Update native host install',
];
const WORKLOG_SUMMARIES = [
  'Patched CORS headers to allow credentials from subdomain origins. Updated 3 files, all tests pass.',
  'Regenerated TypeScript types from OpenAPI spec v2.4. Fixed 3 breaking changes in client SDK.',
  'Added 24 unit tests for session reaper sync/async passes. Coverage increased from 62% to 89%.',
  'Refactored port allocator to use O_EXCL lockfile. Fixed TOCTOU race condition in worktree provisioning.',
  'Fixed heartbeat stale detection threshold. Was using 15min instead of configurable value from automation-config.',
  'Scaffolded vendor onboarding demo with 4 steps: login, create vendor, upload invoice, verify dashboard.',
  'Investigated stale gate agent issue. Root cause: Haiku gate timed out on large task descriptions (>4KB).',
  'Added retry logic with exponential backoff to display lock acquisition. Max 3 retries, 2s initial delay.',
  'Wrote 18 unit tests for shared resource registry. Covers acquire/release/renew/expire/promote flows.',
  'Analyzed 7-day quota consumption patterns. Peak usage 2-4pm, recommend shifting batch jobs to 6-8am.',
  'Fixed race condition in session signal delivery. Signals were being acknowledged before processing.',
  'Implemented dashboard tour scenario with 8 navigation steps. Covers all main dashboard sections.',
  'Merged feature/auth-cors into preview. Squash merge, 3 commits, all CI checks passed.',
  'Added caching layer for session API responses. Cache TTL set to 60s with LRU eviction on 512 entries.',
  'Rewrote console.aws.amazon.com URLs to us-east-1.console.aws. Fixes CORS issues in API relay.',
  'Added diagnostic logging to network relay. Logs request/response headers and timing for debugging.',
  'All demo scenarios passed post-revival. Vendor onboarding 12s, dashboard tour 8s, settings 6s, API 15s.',
  'Demo FAILED at step 8 — chrome extension not installed. Created follow-up task for extension setup.',
  'Fixed tab switching race in chrome extension. Tab IDs were stale after navigation, now re-queried.',
  'Updated demo docs with prerequisite health check patterns. Added PORT-aware examples for worktree compat.',
];

const DESCRIPTIONS = [
  'Review the CI/CD pipeline changes in .github/workflows/ — verify caching, parallel jobs, and deploy conditions.',
  'Investigate why session reaper is not detecting zombie processes. Check PID liveness in sync pass and JSONL timestamps.',
  'Update the changelog with all changes from the v2.4 release branch. Include breaking changes and migration notes.',
  'Fix the CORS headers in auth middleware to allow credentials from *.company.com subdomains. Add test coverage.',
  'Refactor the port allocator to use O_EXCL lockfile pattern. Fix the TOCTOU race in worktree provisioning.',
  'Add unit tests for the session reaper covering both sync and async passes. Target 85% branch coverage.',
  'Scaffold the vendor onboarding demo with prerequisite health checks and PORT-aware worktree compatibility.',
  'Analyze 7-day API quota consumption patterns. Identify peak usage windows and recommend batch job scheduling.',
  'Fix the heartbeat stale detection. Current threshold is hardcoded at 15min, should read from automation-config.',
  'Add caching for session data. Both primary and retry paths need the TTL configuration.',
  'Investigate the stale gate agent issue. Gate may be timing out on large task descriptions exceeding 4KB.',
  'Implement focus mode guard to block automated spawning except CTO-directed and persistent monitor sessions.',
  'Add reserved pool slots for priority-eligible sessions. Non-priority items see reduced max concurrent.',
  'Fix the branch checkout guard to properly handle worktree-specific .mcp.json paths.',
  'Update the auth stall detection to scan last 3 JSONL entries for consecutive auth_error patterns.',
];
const LAST_MESSAGES = [
  'Reading the session-queue.js file to understand the current drain cycle implementation...',
  'I\'ve found the root cause — the PID check in reapSyncPass() is using kill(pid, 0) which succeeds for zombie processes.',
  'Running the test suite with --filter=reaper to verify the fix passes all existing tests.',
  'The CORS headers are now set correctly. I\'ve verified with curl that preflight requests return Access-Control-Allow-Credentials: true.',
  'Checking if the worktree port allocation conflicts with the main tree dev server on port 3000.',
  'I\'ll create a new branch feature/session-reaper-tests and set up the test file structure.',
  'The demo prerequisite health check is passing. Dev server responds on port 3000 within 2 seconds.',
  'Looking at the usage-snapshots.json to extract the 7-day usage data for the analysis.',
  'The heartbeat threshold is now reading from automation-config.json. Default remains 15 minutes if not set.',
  'All hop-by-hop headers are stripped. Verified with a headed demo run that CloudFront responses pass through.',
  'Gate agent timeout confirmed at 30s. Large task descriptions (>4KB) consistently cause Haiku to exceed this limit.',
  'Focus mode guard is implemented. Tested that CTO-priority and persistent-lane sessions still spawn correctly.',
  'Reserved slots set to 2. Verified that low-priority tasks are blocked when capacity is at max - 2.',
  'Branch checkout guard now resolves the absolute worktree path before comparing against the allowed list.',
  'Auth stall detection working. Tested with a mock session file containing 3 consecutive auth_error entries.',
];

function pick<T>(arr: readonly T[], seed: number): T {
  return arr[Math.abs(seed) % arr.length]!;
}

function generateQueuedSessions(count: number): SessionItem[] {
  return Array.from({ length: count }, (_, i) => mkSession({
    id: `sq-q-gen-${i}`,
    status: 'queued',
    priority: pick(PRIORITIES, i * 7 + 3),
    agentType: pick(AGENT_TYPES, i * 13 + 1),
    title: pick(TASK_TITLES, i * 11 + 5),
    lastActionTimestamp: ago(i * 0.5 + 1),
    description: pick(DESCRIPTIONS, i * 3 + 1),
    elapsed: `${i * 3 + 5}s`,
    sessionId: `sq-q-gen-${i}`,
  }));
}

function generateRunningSessions(count: number): SessionItem[] {
  return Array.from({ length: count }, (_, i) => mkSession({
    id: `sq-r-gen-${i}`,
    status: 'alive',
    priority: pick(PRIORITIES, i * 3 + 7),
    agentType: pick(AGENT_TYPES, i * 7 + 2),
    title: pick(TASK_TITLES, i * 13 + 3),
    pid: 50000 + i * 100 + (i * 37 % 99),
    lastAction: pick(ACTIONS, i * 11 + 4),
    lastActionTimestamp: ago(i * 0.3 + 0.1),
    lastMessage: pick(LAST_MESSAGES, i * 5 + 2),
    totalTokens: (i * 137_000 + 50_000) % 2_000_000,
    sessionId: `agent-gen-${i}-${50000 + i * 100}`,
    elapsed: `${Math.floor(i * 2.5 + 1)}m`,
  }));
}

function generateSuspendedSessions(count: number): SessionItem[] {
  const reasons = ['preempted for CTO priority task', 'preempted for critical session', 'memory pressure (high)', 'preempted for persistent monitor revival'];
  return Array.from({ length: count }, (_, i) => mkSession({
    id: `sq-s-gen-${i}`,
    status: 'suspended',
    priority: pick(['normal', 'low', 'normal', 'urgent'] as const, i),
    agentType: pick(AGENT_TYPES, i * 9 + 5),
    title: pick(TASK_TITLES, i * 17 + 2),
    pid: 70000 + i * 50,
    lastAction: pick(ACTIONS, i * 5 + 1),
    lastActionTimestamp: ago(i * 15 + 30),
    lastMessage: pick(LAST_MESSAGES, i * 7 + 3),
    totalTokens: (i * 200_000 + 100_000) % 1_500_000,
    sessionId: `agent-sus-${i}`,
    elapsed: `${Math.floor(i * 10 + 20)}m`,
    killReason: pick(reasons, i),
  }));
}

function generateCompletedSessions(count: number): SessionItem[] {
  return Array.from({ length: count }, (_, i) => {
    const success = (i * 7 + 3) % 5 !== 0; // ~80% success rate
    const durationMs = (i * 137_000 + 180_000) % 1_800_000 + 60_000;
    const tokens = (i * 97_000 + 50_000) % 2_000_000;
    return mkSession({
      id: `sq-c-gen-${i}`,
      status: success ? 'completed' : 'failed',
      priority: pick(PRIORITIES, i * 3 + 1),
      agentType: pick(AGENT_TYPES, i * 11 + 7),
      title: pick(TASK_TITLES, i * 7 + 1),
      lastAction: 'mcp__todo-db__summarize_work',
      lastActionTimestamp: ago(i * 8 + 15),
      totalTokens: tokens,
      sessionId: `agent-done-${i}`,
      elapsed: `${Math.floor(durationMs / 60000)}m ${Math.floor((durationMs % 60000) / 1000)}s`,
      killReason: success ? null : pick(['hard killed (60m limit)', 'auth stall detected', 'OOM killed', 'quota exhausted'], i),
      worklog: mkWorklog(
        pick(WORKLOG_SUMMARIES, i * 3 + 2),
        success,
        durationMs,
        tokens,
      ),
    });
  });
}

// ============================================================================
// Export
// ============================================================================

export function getMockData(): LiveDashboardData {
  const bulkQueued = [...queuedSessions, ...generateQueuedSessions(50)];
  const bulkRunning = [...runningSessions, ...generateRunningSessions(20)];
  const bulkSuspended = [...suspendedSessions, ...generateSuspendedSessions(10)];
  const bulkCompleted = [...completedSessions, ...generateCompletedSessions(1000)];

  return {
    queuedSessions: bulkQueued,
    persistentTasks,
    runningSessions: bulkRunning,
    suspendedSessions: bulkSuspended,
    completedSessions: bulkCompleted,
    capacity: {
      running: pt1SubTasks.filter(s => s.session).length
        + pt2SubTasks.filter(s => s.session).length
        + 2
        + bulkRunning.length,
      max: 50,
    },
    quota,
    deputyCtoSummary,
    systemStatus,
    plans,
    metricsSummary,
    worklogMetrics,
    page2: page2Data,
    page3: page3Data,
    pageAnalytics: pageAnalyticsData,
  };
}
