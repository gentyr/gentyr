/**
 * Mock data for the live CTO dashboard.
 */

import type { LiveDashboardData, SessionItem, PersistentTaskItem, SubTaskItem, WorklogEntry } from './types.js';

function ago(minutes: number): string { return new Date(Date.now() - minutes * 60 * 1000).toISOString(); }

function mkSession(overrides: Partial<SessionItem> & { id: string; title: string; agentType: string }): SessionItem {
  return { status: 'alive', priority: 'normal', pid: null, lastAction: null, lastActionTimestamp: ago(1), lastMessage: null, description: null, killReason: null, totalTokens: null, sessionId: null, elapsed: '0s', worklog: null, worktreePath: null, ...overrides };
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
