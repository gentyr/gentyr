/**
 * Plan Session Reader — correlates 7 independent sources into per-agent
 * session lifecycle views for plan tasks.
 *
 * Sources:
 *   1. plans.db — plan tasks with todo_task_id links
 *   2. agent-tracker-history.json — agent spawn/reap records
 *   3. quota-interrupted-sessions.json — quota interrupt records
 *   4. paused-sessions.json — paused session records
 *   5. worklog.db — worklog entries by task_id
 *   6. plans.db state_changes — substep/task/PR state changes
 *
 * Every source read is wrapped in try/catch — missing files degrade
 * gracefully rather than returning an error.
 */

import * as fs from 'fs';
import * as path from 'path';
import { openReadonlyDb } from './readonly-db.js';

// ============================================================================
// Public interfaces
// ============================================================================

export type SessionEventType =
  | 'session_spawned'
  | 'quota_interrupt'
  | 'session_interrupted'
  | 'session_paused'
  | 'session_revived'
  | 'substep_completed'
  | 'task_status_changed'
  | 'worklog_entry'
  | 'pr_created'
  | 'pr_merged'
  | 'plan_task_completed';

export interface SessionEvent {
  timestamp: string;  // ISO
  type: SessionEventType;
  label: string;
  detail?: string;
}

export interface PlanSessionInfo {
  agentId: string;
  agentType: string;
  pid: number | null;
  planTaskTitle: string;
  planTaskId: string;
  todoTaskId: string;
  status: string;  // 'running' | 'completed' | 'interrupted' | 'paused'
  durationMs: number;
  tokensTotal: number;
  events: SessionEvent[];
}

export interface PlanSessionSummary {
  totalSessions: number;
  running: number;
  completed: number;
  interrupted: number;
  revived: number;
  totalTokens: number;
}

export interface PlanSessionData {
  hasData: boolean;
  sessions: PlanSessionInfo[];
  summary: PlanSessionSummary;
}

// ============================================================================
// Internal types
// ============================================================================

interface AgentHistoryEntry {
  id: string;
  type: string;
  pid?: number | null;
  timestamp: string;
  reapedAt?: string | null;
  status?: string;
  metadata?: {
    taskId?: string;
    [key: string]: unknown;
  };
}

interface QuotaInterruptEntry {
  agentId?: string;
  [key: string]: unknown;
}

interface PausedSessionEntry {
  agentId?: string;
  [key: string]: unknown;
}

interface WorklogRow {
  task_id: string;
  tokens_total: number;
  created_at: string;
  outcome: string | null;
}

interface StateChangeRow {
  entity_type: string;
  entity_id: string;
  field_name: string;
  old_value: string | null;
  new_value: string | null;
  changed_at: string;
}

// ============================================================================
// Empty result
// ============================================================================

const EMPTY: PlanSessionData = {
  hasData: false,
  sessions: [],
  summary: {
    totalSessions: 0,
    running: 0,
    completed: 0,
    interrupted: 0,
    revived: 0,
    totalTokens: 0,
  },
};

// ============================================================================
// Main reader
// ============================================================================

export function getPlanSessionData(): PlanSessionData {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // ============================================================================
  // Step 1: Open plans.db, collect plan tasks with todo_task_id
  // ============================================================================

  const todoTaskToPlantTask = new Map<string, { planTaskId: string; planTaskTitle: string }>();

  try {
    const dbPath = path.join(projectDir, '.claude', 'state', 'plans.db');
    if (fs.existsSync(dbPath)) {
      const db = openReadonlyDb(dbPath);
      try {
        const tasks = db.prepare(
          `SELECT pt.id, pt.title, pt.todo_task_id
           FROM plan_tasks pt
           JOIN plans p ON pt.plan_id = p.id
           WHERE pt.todo_task_id IS NOT NULL
             AND p.status IN ('draft', 'active', 'paused', 'completed')`
        ).all() as Array<{ id: string; title: string; todo_task_id: string }>;

        for (const t of tasks) {
          todoTaskToPlantTask.set(t.todo_task_id, { planTaskId: t.id, planTaskTitle: t.title });
        }
      } finally {
        try { db.close(); } catch { /* ignore */ }
      }
    }
  } catch {
    // plans.db unavailable — no plan sessions to show
  }

  if (todoTaskToPlantTask.size === 0) {
    return EMPTY;
  }

  // ============================================================================
  // Step 2: Read agent-tracker-history.json, filter by matching todo task IDs
  // ============================================================================

  let allAgentHistory: AgentHistoryEntry[] = [];

  try {
    const historyPath = path.join(projectDir, '.claude', 'state', 'agent-tracker-history.json');
    if (fs.existsSync(historyPath)) {
      const raw = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
      if (Array.isArray(raw)) {
        allAgentHistory = raw;
      }
    }
  } catch {
    // Agent history unavailable
  }

  const matchedAgents = allAgentHistory.filter(
    (a) => a.metadata?.taskId && todoTaskToPlantTask.has(a.metadata.taskId)
  );

  if (matchedAgents.length === 0) {
    return EMPTY;
  }

  // ============================================================================
  // Step 3: Build PlanSessionInfo for each matched agent
  // ============================================================================

  const sessions: PlanSessionInfo[] = matchedAgents.map((agent) => {
    const todoTaskId = agent.metadata!.taskId as string;
    const planInfo = todoTaskToPlantTask.get(todoTaskId)!;

    const spawnedEvent: SessionEvent = {
      timestamp: agent.timestamp,
      type: 'session_spawned',
      label: 'Session Spawned',
      detail: `${agent.type}, PID ${agent.pid ?? 'unknown'}`,
    };

    return {
      agentId: agent.id,
      agentType: agent.type,
      pid: agent.pid ?? null,
      planTaskTitle: planInfo.planTaskTitle,
      planTaskId: planInfo.planTaskId,
      todoTaskId,
      status: deriveStatus(agent),
      durationMs: 0,  // computed in step 10
      tokensTotal: 0, // populated from worklog in step 8
      events: [spawnedEvent],
    };
  });

  // Build lookup maps for later steps
  const sessionById = new Map<string, PlanSessionInfo>(sessions.map((s) => [s.agentId, s]));
  const sessionByTodoTaskId = new Map<string, PlanSessionInfo[]>();
  for (const s of sessions) {
    const arr = sessionByTodoTaskId.get(s.todoTaskId) ?? [];
    arr.push(s);
    sessionByTodoTaskId.set(s.todoTaskId, arr);
  }

  // Build a map agentId -> AgentHistoryEntry for window lookups
  const agentById = new Map<string, AgentHistoryEntry>(matchedAgents.map((a) => [a.id, a]));

  // ============================================================================
  // Step 5: Read quota-interrupted-sessions.json
  // ============================================================================

  try {
    const quotaPath = path.join(projectDir, '.claude', 'state', 'quota-interrupted-sessions.json');
    if (fs.existsSync(quotaPath)) {
      const quotaData = JSON.parse(fs.readFileSync(quotaPath, 'utf8'));
      const entries: QuotaInterruptEntry[] = Array.isArray(quotaData) ? quotaData : [];

      for (const entry of entries) {
        if (!entry.agentId) continue;
        const session = sessionById.get(entry.agentId);
        if (!session) continue;

        const agent = agentById.get(entry.agentId);
        const tsStr = (entry as Record<string, unknown>).interrupted_at as string | undefined
          ?? agent?.reapedAt
          ?? new Date().toISOString();

        session.events.push({
          timestamp: tsStr,
          type: 'quota_interrupt',
          label: 'Quota Interrupt',
          detail: (entry as Record<string, unknown>).reason as string | undefined ?? 'quota exhausted',
        });
        session.events.push({
          timestamp: tsStr,
          type: 'session_interrupted',
          label: 'Session Interrupted',
        });

        if (session.status === 'running') {
          session.status = 'interrupted';
        }
      }
    }
  } catch {
    // Quota interrupt file unavailable
  }

  // ============================================================================
  // Step 6: Read paused-sessions.json
  // ============================================================================

  try {
    const pausedPath = path.join(projectDir, '.claude', 'state', 'paused-sessions.json');
    if (fs.existsSync(pausedPath)) {
      const pausedData = JSON.parse(fs.readFileSync(pausedPath, 'utf8'));
      const entries: PausedSessionEntry[] = Array.isArray(pausedData) ? pausedData : [];

      for (const entry of entries) {
        if (!entry.agentId) continue;
        const session = sessionById.get(entry.agentId);
        if (!session) continue;

        const tsStr = (entry as Record<string, unknown>).paused_at as string | undefined
          ?? new Date().toISOString();

        session.events.push({
          timestamp: tsStr,
          type: 'session_paused',
          label: 'Session Paused',
        });

        if (session.status === 'running') {
          session.status = 'paused';
        }
      }
    }
  } catch {
    // Paused sessions file unavailable
  }

  // ============================================================================
  // Step 7: Find revival agents and push session_revived on original sessions
  // ============================================================================

  try {
    for (const revivalAgent of allAgentHistory) {
      if (revivalAgent.type !== 'session-revived') continue;
      const resumedId = (revivalAgent.metadata as Record<string, unknown>)?.resumedAgentId as string | undefined;
      if (!resumedId) continue;

      const originalSession = sessionById.get(resumedId);
      if (!originalSession) continue;

      originalSession.events.push({
        timestamp: revivalAgent.timestamp,
        type: 'session_revived',
        label: 'Session Revived',
        detail: `by ${revivalAgent.id}`,
      });
    }
  } catch {
    // Revival correlation unavailable
  }

  // ============================================================================
  // Step 8: Open worklog.db, query entries by todo task IDs
  // ============================================================================

  try {
    const worklogPath = path.join(projectDir, '.claude', 'worklog.db');
    if (fs.existsSync(worklogPath)) {
      const wdb = openReadonlyDb(worklogPath);
      try {
        const todoTaskIds = Array.from(sessionByTodoTaskId.keys());
        if (todoTaskIds.length > 0) {
          const placeholders = todoTaskIds.map(() => '?').join(',');
          const rows = wdb.prepare(
            `SELECT task_id, tokens_total, created_at, outcome
             FROM worklog_entries
             WHERE task_id IN (${placeholders})
             ORDER BY created_at ASC`
          ).all(...todoTaskIds) as WorklogRow[];

          for (const row of rows) {
            const relatedSessions = sessionByTodoTaskId.get(row.task_id) ?? [];
            // Assign worklog entry to the most recently spawned session for this task
            const session = relatedSessions[relatedSessions.length - 1];
            if (!session) continue;

            session.tokensTotal += row.tokens_total ?? 0;
            session.events.push({
              timestamp: row.created_at,
              type: 'worklog_entry',
              label: 'Worklog Entry',
              detail: row.outcome ?? `${formatTokensCompact(row.tokens_total ?? 0)} tokens`,
            });
          }
        }
      } finally {
        try { wdb.close(); } catch { /* ignore */ }
      }
    }
  } catch {
    // Worklog DB unavailable
  }

  // ============================================================================
  // Step 9: Query state_changes from plans.db for each plan task's entity IDs
  // ============================================================================

  try {
    const dbPath = path.join(projectDir, '.claude', 'state', 'plans.db');
    if (fs.existsSync(dbPath)) {
      const db = openReadonlyDb(dbPath);
      try {
        const planTaskIds = [...new Set(sessions.map((s) => s.planTaskId))];
        if (planTaskIds.length > 0) {
          // Group sessions by planTaskId for timestamp-based routing
          const sessionsByPlanTaskId = new Map<string, PlanSessionInfo[]>();
          for (const s of sessions) {
            const arr = sessionsByPlanTaskId.get(s.planTaskId) ?? [];
            arr.push(s);
            sessionsByPlanTaskId.set(s.planTaskId, arr);
          }

          for (const planTaskId of planTaskIds) {
            const relatedSessions = sessionsByPlanTaskId.get(planTaskId);
            if (!relatedSessions || relatedSessions.length === 0) continue;

            // Get substep IDs for this task
            const substepIds = (
              db.prepare('SELECT id FROM substeps WHERE task_id = ?').all(planTaskId) as Array<{ id: string }>
            ).map((r) => r.id);

            const entityIds = [planTaskId, ...substepIds];
            const placeholders = entityIds.map(() => '?').join(',');
            const changes = db.prepare(
              `SELECT entity_type, entity_id, field_name, old_value, new_value, changed_at
               FROM state_changes
               WHERE entity_id IN (${placeholders})
               ORDER BY changed_at ASC`
            ).all(...entityIds) as StateChangeRow[];

            for (const change of changes) {
              // Route event to the correct session by timestamp window
              const changeMs = new Date(change.changed_at).getTime();
              const nowMs = Date.now();
              let targetSession: PlanSessionInfo | undefined;
              for (const s of relatedSessions) {
                const spawnMs = new Date(s.events[0]?.timestamp ?? '').getTime();
                const endMs = s.status === 'running' ? nowMs : (s.durationMs > 0 ? spawnMs + s.durationMs : nowMs);
                if (changeMs >= spawnMs && changeMs <= endMs) {
                  targetSession = s;
                  break;
                }
              }
              // Fallback: assign to last session if no window match
              if (!targetSession) targetSession = relatedSessions[relatedSessions.length - 1];

              if (change.entity_type === 'substep' && change.field_name === 'completed' && change.new_value === '1') {
                const substepRow = db.prepare('SELECT title FROM substeps WHERE id = ?').get(change.entity_id) as { title: string } | undefined;
                targetSession.events.push({
                  timestamp: change.changed_at,
                  type: 'substep_completed',
                  label: 'Substep Completed',
                  detail: substepRow?.title ?? change.entity_id.substring(0, 8),
                });
              } else if (change.entity_type === 'task' && change.field_name === 'status') {
                if (change.new_value === 'completed') {
                  targetSession.events.push({
                    timestamp: change.changed_at,
                    type: 'plan_task_completed',
                    label: 'Plan Task Completed',
                  });
                } else {
                  targetSession.events.push({
                    timestamp: change.changed_at,
                    type: 'task_status_changed',
                    label: 'Task Status Changed',
                    detail: `${change.old_value ?? '?'} → ${change.new_value ?? '?'}`,
                  });
                }
              } else if (change.entity_type === 'task' && change.field_name === 'pr_number' && change.new_value) {
                targetSession.events.push({
                  timestamp: change.changed_at,
                  type: 'pr_created',
                  label: `PR #${change.new_value} Created`,
                  detail: change.new_value,
                });
              } else if (change.entity_type === 'task' && change.field_name === 'pr_merged' && change.new_value === '1') {
                const taskRow = db.prepare('SELECT pr_number FROM plan_tasks WHERE id = ?').get(change.entity_id) as { pr_number: number | null } | undefined;
                const prNum = taskRow?.pr_number;
                targetSession.events.push({
                  timestamp: change.changed_at,
                  type: 'pr_merged',
                  label: prNum ? `PR #${prNum} Merged` : 'PR Merged',
                  detail: prNum ? String(prNum) : undefined,
                });
              }
            }
          }
        }
      } finally {
        try { db.close(); } catch { /* ignore */ }
      }
    }
  } catch {
    // State changes unavailable
  }

  // ============================================================================
  // Step 10: Sort events, compute durations, build summary
  // ============================================================================

  const now = Date.now();

  let running = 0;
  let completed = 0;
  let interrupted = 0;
  let revived = 0;
  let totalTokens = 0;

  for (const session of sessions) {
    // Sort events by timestamp
    session.events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    // Compute duration
    const agent = agentById.get(session.agentId);
    const startMs = agent ? new Date(agent.timestamp).getTime() : now;
    const endMs = agent?.reapedAt ? new Date(agent.reapedAt).getTime() : now;
    session.durationMs = Math.max(0, endMs - startMs);

    // Count by status
    switch (session.status) {
      case 'running': running++; break;
      case 'completed': completed++; break;
      case 'interrupted': interrupted++; break;
      case 'paused': interrupted++; break;
    }

    // Count revivals
    if (session.events.some((e) => e.type === 'session_revived')) {
      revived++;
    }

    totalTokens += session.tokensTotal;
  }

  const summary: PlanSessionSummary = {
    totalSessions: sessions.length,
    running,
    completed,
    interrupted,
    revived,
    totalTokens,
  };

  return {
    hasData: sessions.length > 0,
    sessions,
    summary,
  };
}

// ============================================================================
// Helpers
// ============================================================================

function deriveStatus(agent: AgentHistoryEntry): string {
  if (!agent.reapedAt) return 'running';
  const s = agent.status?.toLowerCase() ?? '';
  if (s === 'completed' || s === 'success') return 'completed';
  if (s === 'interrupted') return 'interrupted';
  if (s === 'paused') return 'paused';
  // If reaped without explicit status, assume completed
  return 'completed';
}

function formatTokensCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}
