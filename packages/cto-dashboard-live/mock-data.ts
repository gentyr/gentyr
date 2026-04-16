/**
 * Mock data for the live CTO dashboard.
 */

import type { LiveDashboardData, SessionItem, PersistentTaskItem, SubTaskItem, WorklogEntry, Page2Data, DemoScenarioItem, TestFileItem, Page3Data, PlanItem, PlanPhaseItem, PlanTaskItem, PlanSubstepItem, PlanStateChange, Page4Data, SpecCategoryItem, SpecItem, SuiteItem } from './types.js';

function ago(minutes: number): string { return new Date(Date.now() - minutes * 60 * 1000).toISOString(); }

function mkSession(overrides: Partial<SessionItem> & { id: string; title: string; agentType: string }): SessionItem {
  return { status: 'alive', priority: 'normal', pid: null, lastAction: null, lastActionTimestamp: ago(1), lastMessage: null, description: null, killReason: null, totalTokens: null, sessionId: null, elapsed: '0s', worklog: null, worktreePath: null, startedAt: ago(5), completedAt: null, ...overrides };
}

function mkWorklog(summary: string, success: boolean, durationMs: number, tokens: number): WorklogEntry {
  return { summary, success, durationMs, tokens };
}

const queuedSessions: SessionItem[] = [
  mkSession({ id: 'sq-q001', status: 'queued', priority: 'cto', agentType: 'code-reviewer', title: 'Review deployment pipeline changes', description: 'Review CI/CD pipeline modifications', elapsed: '2m30s' }),
];

const runningSessions: SessionItem[] = [
  mkSession({ id: 'sq-r001', status: 'alive', agentType: 'code-writer', title: 'Implement OAuth2 PKCE flow', pid: 12345, lastAction: 'Edit src/auth/pkce.ts', lastActionTimestamp: ago(0.5), sessionId: 'agent-r001-abc123', elapsed: '15m' }),
  mkSession({ id: 'sq-r002', status: 'alive', priority: 'urgent', agentType: 'test-writer', title: 'Add integration tests for payments API', pid: 12346, lastAction: 'Bash npm test', lastActionTimestamp: ago(1), sessionId: 'agent-r002-def456', elapsed: '8m30s' }),
];

const suspendedSessions: SessionItem[] = [
  mkSession({ id: 'sq-s001', status: 'suspended', priority: 'low', agentType: 'code-writer', title: 'Refactor legacy logging module', pid: 12350, sessionId: 'agent-s001-sus123', elapsed: '45m' }),
];

const completedSessions: SessionItem[] = [
  mkSession({ id: 'sq-c001', status: 'completed', agentType: 'code-writer', title: 'Fix CSS grid layout in dashboard', elapsed: '12m', worklog: mkWorklog('Fixed responsive grid breakpoints', true, 720000, 45000), sessionId: 'agent-c001-done1' }),
  mkSession({ id: 'sq-c002', status: 'failed', agentType: 'demo-manager', title: 'Run auth demo scenario', elapsed: '5m', worklog: mkWorklog('Demo failed: timeout waiting for MFA', false, 300000, 20000), sessionId: 'agent-c002-done2' }),
];

const persistentTasks: PersistentTaskItem[] = [{
  id: 'pt-001', title: 'AWS Login Chain: Real Chrome + Bridged Playwright', status: 'active', age: '5h34m', cycleCount: 12, heartbeatAge: '2m', heartbeatStale: false, demoInvolved: true, strictInfraGuidance: true,
  monitorSession: mkSession({ id: 'pt-monitor-pt-001', status: 'alive', priority: 'critical', agentType: 'persistent-monitor', title: 'Monitor: AWS Login Chain', pid: 64325, sessionId: 'agent-mon001-xyz', elapsed: '5h34m' }),
  subTasks: [
    { id: 'st-001a', title: 'Step A: Real Chrome AWS root user login', status: 'completed', section: 'CODE-REVIEWER', session: null, agentStage: null, agentProgressPct: null, prUrl: 'https://github.com/org/repo/pull/123', prMerged: true, worklog: mkWorklog('Implemented MFA handler', true, 1800000, 80000) },
    { id: 'st-001b', title: 'Step B: Build bridge relay proxy test', status: 'in_progress', section: 'CODE-REVIEWER', session: mkSession({ id: 'sq-child-001b', status: 'alive', agentType: 'code-reviewer', title: 'Force-spawn: code-reviewer for Step B', pid: 64400, lastAction: 'Edit src/bridge/relay.ts', lastActionTimestamp: ago(2), sessionId: 'agent-child001b-999', elapsed: '25m' }), agentStage: 'code-reviewer', agentProgressPct: 65, prUrl: null, prMerged: false, worklog: null },
    { id: 'pending-summary-pt-001', title: '3 pending tasks', status: 'pending', section: '', session: null, agentStage: null, agentProgressPct: null, prUrl: null, prMerged: false, worklog: null },
  ],
}];

export function getMockData(): LiveDashboardData {
  return { queuedSessions, persistentTasks, runningSessions, suspendedSessions, completedSessions, capacity: { running: 4, max: 10 } };
}

const mockScenarios: DemoScenarioItem[] = [
  { id: 'demo-001', personaId: 'p1', personaName: 'Vendor (Owner)', title: 'Complete vendor onboarding flow', description: 'End-to-end onboarding', category: 'onboarding', playwrightProject: 'vendor-owner', testFile: 'e2e/demo/vendor-onboarding.demo.ts', sortOrder: 1, enabled: true, headed: true, lastRecordedAt: ago(120), recordingPath: '/tmp/mock-demo-001.mp4', envVars: null },
  { id: 'demo-002', personaId: 'p2', personaName: 'Vendor (Admin)', title: 'Admin dashboard navigation', description: 'Navigate admin pages', category: 'navigation', playwrightProject: 'vendor-admin', testFile: 'e2e/demo/admin-nav.demo.ts', sortOrder: 2, enabled: true, headed: false, lastRecordedAt: ago(360), recordingPath: null, envVars: null },
  { id: 'demo-003', personaId: 'p1', personaName: 'Vendor (Owner)', title: 'Payment processing flow', description: 'Process a payment', category: 'payments', playwrightProject: 'vendor-owner', testFile: 'e2e/demo/payment-flow.demo.ts', sortOrder: 3, enabled: false, headed: true, lastRecordedAt: null, recordingPath: null, envVars: null },
  { id: 'demo-004', personaId: 'p3', personaName: 'Cross-Persona', title: 'AWS one-click deploy', description: 'Deploy to AWS', category: 'deploy', playwrightProject: 'cross-persona', testFile: 'e2e/demo/ext-aws-one-click.demo.ts', sortOrder: 4, enabled: true, headed: true, lastRecordedAt: ago(30), recordingPath: '/tmp/mock-demo-004.mp4', envVars: { ALLOW_E2E: '1' } },
];

const mockTestFiles: TestFileItem[] = [
  { project: 'vendor-owner', filePath: 'e2e/demo/vendor-onboarding.demo.ts', fileName: 'vendor-onboarding.demo.ts', isDemo: true, runner: 'playwright' },
  { project: 'vendor-owner', filePath: 'e2e/demo/payment-flow.demo.ts', fileName: 'payment-flow.demo.ts', isDemo: true, runner: 'playwright' },
  { project: 'vendor-owner', filePath: 'e2e/vendor/vendor-dashboard.spec.ts', fileName: 'vendor-dashboard.spec.ts', isDemo: false, runner: 'playwright' },
  { project: 'vendor-owner', filePath: 'e2e/vendor/vendor-settings.spec.ts', fileName: 'vendor-settings.spec.ts', isDemo: false, runner: 'playwright' },
  { project: 'vendor-admin', filePath: 'e2e/demo/admin-nav.demo.ts', fileName: 'admin-nav.demo.ts', isDemo: true, runner: 'playwright' },
  { project: 'vendor-admin', filePath: 'e2e/admin/admin-settings.spec.ts', fileName: 'admin-settings.spec.ts', isDemo: false, runner: 'playwright' },
  { project: 'cross-persona', filePath: 'e2e/demo/ext-aws-one-click.demo.ts', fileName: 'ext-aws-one-click.demo.ts', isDemo: true, runner: 'playwright' },
  { project: 'cross-persona', filePath: 'e2e/cross/role-switching.spec.ts', fileName: 'role-switching.spec.ts', isDemo: false, runner: 'playwright' },
  { project: 'test/integration', filePath: 'test/integration/proxy-bridge.test.ts', fileName: 'proxy-bridge.test.ts', isDemo: false, runner: 'vitest' },
  { project: 'test/integration', filePath: 'test/integration/toyapp-backend.test.ts', fileName: 'toyapp-backend.test.ts', isDemo: false, runner: 'vitest' },
  { project: 'test/global', filePath: 'test/global/integration-structure.test.ts', fileName: 'integration-structure.test.ts', isDemo: false, runner: 'vitest' },
  { project: 'hooks', filePath: '.claude/hooks/__tests__/session-queue-dedup.test.js', fileName: 'session-queue-dedup.test.js', isDemo: false, runner: 'vitest' },
  { project: 'hooks', filePath: '.claude/hooks/__tests__/bypass-deny.test.js', fileName: 'bypass-deny.test.js', isDemo: false, runner: 'vitest' },
];

export function getMockPage2Data(): Page2Data {
  return { scenarios: mockScenarios, testFiles: mockTestFiles };
}

// ============================================================================
// Mock Page 3: Plans
// ============================================================================

const mockSubstepsA: PlanSubstepItem[] = [
  { id: 'ss-a1', title: 'Create VPCs in us-east-1 and eu-west-1', completed: true },
  { id: 'ss-a2', title: 'Configure security groups', completed: true },
  { id: 'ss-a3', title: 'Verify cross-region connectivity', completed: true },
];

const mockSubstepsB: PlanSubstepItem[] = [
  { id: 'ss-b1', title: 'Write CloudFormation templates', completed: true },
  { id: 'ss-b2', title: 'Run deployment dry-run', completed: true },
  { id: 'ss-b3', title: 'Deploy to staging', completed: false },
  { id: 'ss-b4', title: 'Validate outputs', completed: false },
  { id: 'ss-b5', title: 'Deploy to production', completed: false },
];

const mockSubstepsC: PlanSubstepItem[] = [
  { id: 'ss-c1', title: 'Install Prometheus', completed: false },
  { id: 'ss-c2', title: 'Configure alerting rules', completed: false },
  { id: 'ss-c3', title: 'Set up Grafana dashboards', completed: false },
  { id: 'ss-c4', title: 'Test alerts end-to-end', completed: false },
];

const mockSubstepsD: PlanSubstepItem[] = [
  { id: 'ss-d1', title: 'Design migration strategy', completed: false },
  { id: 'ss-d2', title: 'Test rollback procedure', completed: false },
  { id: 'ss-d3', title: 'Document migration runbook', completed: false },
];

const mockTasksPhase1: PlanTaskItem[] = [
  {
    id: 'pt-task-a', title: 'Configure AWS regions', status: 'completed',
    agentType: 'code-writer', categoryId: null, prNumber: 42, prMerged: true,
    persistentTaskId: null, substeps: mockSubstepsA, substepProgress: '3/3', progressPct: 100, blockedBy: [],
  },
  {
    id: 'pt-task-b', title: 'Deploy base CloudFormation templates', status: 'in_progress',
    agentType: 'code-writer', categoryId: null, prNumber: null, prMerged: false,
    persistentTaskId: 'mock-persistent-1', substeps: mockSubstepsB, substepProgress: '2/5', progressPct: 40, blockedBy: [],
  },
  {
    id: 'pt-task-c', title: 'Setup monitoring and alerting', status: 'pending',
    agentType: null, categoryId: null, prNumber: null, prMerged: false,
    persistentTaskId: null, substeps: mockSubstepsC, substepProgress: '0/4', progressPct: 0, blockedBy: [],
  },
];

const mockTasksPhase2: PlanTaskItem[] = [
  {
    id: 'pt-task-d', title: 'Plan migration strategy', status: 'ready',
    agentType: null, categoryId: null, prNumber: null, prMerged: false,
    persistentTaskId: null, substeps: mockSubstepsD, substepProgress: '0/3', progressPct: 0, blockedBy: [],
  },
  {
    id: 'pt-task-e', title: 'Execute data migration', status: 'blocked',
    agentType: null, categoryId: null, prNumber: null, prMerged: false,
    persistentTaskId: null, substeps: [], substepProgress: '0/0', progressPct: 0,
    blockedBy: ['Plan migration strategy'],
  },
  {
    id: 'pt-task-f', title: 'Validate migrated data', status: 'pending',
    agentType: null, categoryId: null, prNumber: null, prMerged: false,
    persistentTaskId: null, substeps: [], substepProgress: '0/0', progressPct: 0,
    blockedBy: ['Execute data migration'],
  },
];

const mockTasksPhase3: PlanTaskItem[] = [
  {
    id: 'pt-task-g', title: 'Smoke test production', status: 'pending',
    agentType: null, categoryId: null, prNumber: null, prMerged: false,
    persistentTaskId: null, substeps: [], substepProgress: '0/0', progressPct: 0, blockedBy: [],
  },
];

const mockPhasesDetail: PlanPhaseItem[] = [
  { id: 'ph-1', title: 'Setup Infrastructure', phaseOrder: 1, status: 'in_progress', progressPct: 47, tasks: mockTasksPhase1 },
  { id: 'ph-2', title: 'Data Migration', phaseOrder: 2, status: 'pending', progressPct: 0, tasks: mockTasksPhase2 },
  { id: 'ph-3', title: 'Validation & Cutover', phaseOrder: 3, status: 'pending', progressPct: 0, tasks: mockTasksPhase3 },
];

const mockPlans: PlanItem[] = [
  {
    id: 'mock-plan-1', title: 'Infrastructure Migration', status: 'active', progressPct: 16,
    phaseCount: 3, taskCount: 7, completedTasks: 1, readyTasks: 1, activeTasks: 1,
    currentPhase: 'Setup Infrastructure', updatedAt: ago(8), managerPid: 99999, managerAlive: false,
  },
  {
    id: 'mock-plan-2', title: 'Auth System Overhaul', status: 'paused', progressPct: 60,
    phaseCount: 2, taskCount: 4, completedTasks: 2, readyTasks: 0, activeTasks: 0,
    currentPhase: 'Implementation', updatedAt: ago(120), managerPid: null, managerAlive: false,
  },
];

const mockStateChanges: PlanStateChange[] = [
  { label: 'Deploy base CloudFormation templates', field: 'status', oldValue: 'ready', newValue: 'in_progress', changedAt: ago(15) },
  { label: 'Configure AWS regions', field: 'status', oldValue: 'in_progress', newValue: 'completed', changedAt: ago(45) },
  { label: 'Verify cross-region connectivity', field: 'completed', oldValue: '0', newValue: '1', changedAt: ago(50) },
  { label: 'Infrastructure Migration', field: 'status', oldValue: 'draft', newValue: 'active', changedAt: ago(180) },
  { label: 'Setup Infrastructure', field: 'status', oldValue: 'pending', newValue: 'in_progress', changedAt: ago(178) },
];

export function getMockPage3Data(): Page3Data {
  return {
    plans: mockPlans,
    planDetail: { planId: 'mock-plan-1', phases: mockPhasesDetail },
    recentChanges: mockStateChanges,
  };
}

// ============================================================================
// Mock Page 4: Specs
// ============================================================================

const mockFrameworkSpecs: SpecItem[] = [
  { specId: 'G001', title: 'Core Invariants', ruleId: 'G001', severity: 'critical', category: 'framework', filePath: '/mock/specs/framework/G001.md' },
];

const mockPatternSpecs: SpecItem[] = [
  { specId: 'AGENT-PATTERNS', title: 'Agent Patterns', ruleId: null, severity: 'required', category: 'patterns', filePath: '/mock/specs/patterns/AGENT-PATTERNS.md' },
  { specId: 'HOOK-PATTERNS', title: 'Hook Patterns', ruleId: null, severity: 'required', category: 'patterns', filePath: '/mock/specs/patterns/HOOK-PATTERNS.md' },
  { specId: 'MCP-SERVER-PATTERNS', title: 'MCP Server Patterns', ruleId: null, severity: null, category: 'patterns', filePath: '/mock/specs/patterns/MCP-SERVER-PATTERNS.md' },
];

const mockGlobalSpecs: SpecItem[] = [
  { specId: 'TESTING', title: 'Testing Strategy', ruleId: null, severity: 'required', category: 'global', filePath: '/mock/specs/global/TESTING.md' },
  { specId: 'INTEGRATION-STRUCTURE', title: 'Integration Structure', ruleId: null, severity: null, category: 'global', filePath: '/mock/specs/global/INTEGRATION-STRUCTURE.md' },
];

const mockSpecCategories: SpecCategoryItem[] = [
  { key: 'framework', description: 'Core framework invariants', source: 'framework', specs: mockFrameworkSpecs },
  { key: 'patterns', description: 'Framework patterns and conventions', source: 'framework', specs: mockPatternSpecs },
  { key: 'global', description: 'Global project invariants', source: 'project', specs: mockGlobalSpecs },
];

const mockSuites: SuiteItem[] = [
  { id: 'auth-integration', description: 'Auth integration tests', scope: 'e2e/auth/**', enabled: true },
];

const mockSelectedSpecContent = `# Core Invariants (G001)

**Rule ID**: G001
**Severity**: critical

## Overview

These are the non-negotiable invariants that all code in this framework must follow.

## Rules

1. **No graceful fallbacks** — failures must be loud and explicit
2. **Validate all external input** — use Zod schemas at boundaries
3. **Never log secrets** — credentials, tokens, and keys must never appear in logs
4. **Fail closed** — when in doubt, deny access

## Examples

\`\`\`typescript
// CORRECT: loud failure
if (!token) throw new Error('Missing auth token');

// WRONG: silent fallback
const token = process.env.TOKEN || 'default';
\`\`\`
`;

export function getMockPage4Data(): Page4Data {
  return {
    categories: mockSpecCategories,
    suites: mockSuites,
    totalSpecs: mockFrameworkSpecs.length + mockPatternSpecs.length + mockGlobalSpecs.length,
    selectedSpecContent: mockSelectedSpecContent,
  };
}
