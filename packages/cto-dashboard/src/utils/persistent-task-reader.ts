/**
 * Persistent Task Data Reader
 *
 * Reads persistent-tasks.db for dashboard rendering.
 */

import * as fs from 'fs';
import * as path from 'path';
import { openReadonlyDb } from './readonly-db.js';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const PT_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
const TODO_DB_PATH = path.join(PROJECT_DIR, '.claude', 'todo.db');

// ============================================================================
// Public Interfaces
// ============================================================================

export interface PersistentTaskInfo {
  id: string;
  title: string;
  status: string;
  subTaskCount: number;
  subTasksCompleted: number;
  subTasksInProgress: number;
  subTasksPending: number;
  progressPct: number;
  monitorPid: number | null;
  monitorAlive: boolean;
  monitorStatus: string;
  amendmentCount: number;
  pendingAmendments: number;
  age: string;
  stalled: boolean;
  activatedAt: string | null;
  lastHeartbeat: string | null;
  cycleCount: number;
}

export interface PersistentTaskData {
  hasData: boolean;
  tasks: PersistentTaskInfo[];
  totalActive: number;
  monitorsAlive: number;
  monitorsDead: number;
  pendingAmendments: number;
}

// ============================================================================
// Internal Row Types
// ============================================================================

interface PersistentTaskRow {
  id: string;
  title: string;
  status: string;
  monitor_pid: number | null;
  activated_at: string | null;
  last_heartbeat: string | null;
  cycle_count: number | null;
}

interface AmendmentCountRow {
  total: number;
  pending: number;
}

interface SubTaskRow {
  todo_task_id: string;
}

interface TodoTaskStatusRow {
  status: string;
}

// ============================================================================
// Helpers
// ============================================================================

const EMPTY: PersistentTaskData = {
  hasData: false,
  tasks: [],
  totalActive: 0,
  monitorsAlive: 0,
  monitorsDead: 0,
  pendingAmendments: 0,
};

function formatAge(isoTimestamp: string | null): string {
  if (!isoTimestamp) return '?';
  const ms = Date.now() - new Date(isoTimestamp).getTime();
  if (ms < 0) return '0s';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isStalled(lastHeartbeat: string | null): boolean {
  if (!lastHeartbeat) return true;
  const ms = Date.now() - new Date(lastHeartbeat).getTime();
  return ms > 60 * 60 * 1000; // stalled if no heartbeat in 60 minutes
}

// ============================================================================
// Main Reader
// ============================================================================

export function getPersistentTaskData(): PersistentTaskData {
  if (!fs.existsSync(PT_DB_PATH)) return EMPTY;

  let db;
  try {
    db = openReadonlyDb(PT_DB_PATH);
  } catch {
    return EMPTY;
  }

  let todoDB: ReturnType<typeof openReadonlyDb> | null = null;

  try {
    const rows = db.prepare(
      "SELECT id, title, status, monitor_pid, activated_at, last_heartbeat, cycle_count FROM persistent_tasks WHERE status NOT IN ('draft') ORDER BY activated_at DESC"
    ).all() as PersistentTaskRow[];

    if (rows.length === 0) {
      db.close();
      return EMPTY;
    }

    // Open todo.db once if it exists (for sub-task status lookups)
    if (fs.existsSync(TODO_DB_PATH)) {
      try {
        todoDB = openReadonlyDb(TODO_DB_PATH);
      } catch {
        // Non-critical — sub-task counts will default to 0
      }
    }

    let totalActive = 0;
    let monitorsAlive = 0;
    let monitorsDead = 0;
    let totalPendingAmendments = 0;

    const tasks: PersistentTaskInfo[] = rows.map(row => {
      if (row.status === 'active') totalActive++;

      // PID liveness check
      const alive = row.monitor_pid !== null && isPidAlive(row.monitor_pid);
      if (row.status === 'active') {
        if (alive) monitorsAlive++;
        else monitorsDead++;
      }

      // Amendment counts
      const amendRow = db.prepare(
        "SELECT COUNT(*) as total, SUM(CASE WHEN acknowledged_at IS NULL THEN 1 ELSE 0 END) as pending FROM amendments WHERE persistent_task_id = ?"
      ).get(row.id) as AmendmentCountRow | undefined;
      const amendmentCount = amendRow?.total ?? 0;
      const pendingAmendments = amendRow?.pending ?? 0;
      totalPendingAmendments += pendingAmendments;

      // Sub-task counts via sub_tasks join table + todo.db
      let subTaskCount = 0;
      let subTasksCompleted = 0;
      let subTasksInProgress = 0;
      let subTasksPending = 0;

      if (todoDB) {
        try {
          const subTaskRows = db.prepare(
            "SELECT todo_task_id FROM sub_tasks WHERE persistent_task_id = ?"
          ).all(row.id) as SubTaskRow[];

          subTaskCount = subTaskRows.length;

          for (const st of subTaskRows) {
            const todoRow = todoDB.prepare(
              "SELECT status FROM tasks WHERE id = ?"
            ).get(st.todo_task_id) as TodoTaskStatusRow | undefined;

            if (!todoRow) continue;
            if (todoRow.status === 'completed') subTasksCompleted++;
            else if (todoRow.status === 'in_progress') subTasksInProgress++;
            else subTasksPending++;
          }
        } catch {
          // Non-critical
        }
      }

      const progressPct = subTaskCount > 0
        ? Math.round((subTasksCompleted / subTaskCount) * 100)
        : 0;

      const activatedAt = row.activated_at ?? null;
      const lastHeartbeat = row.last_heartbeat ?? null;
      const age = formatAge(activatedAt ?? (row as any).created_at ?? null);
      const stalled = row.status === 'active' && isStalled(lastHeartbeat);

      return {
        id: row.id,
        title: row.title,
        status: row.status,
        subTaskCount,
        subTasksCompleted,
        subTasksInProgress,
        subTasksPending,
        progressPct,
        monitorPid: row.monitor_pid,
        monitorAlive: alive,
        monitorStatus: alive ? 'running' : 'dead',
        amendmentCount,
        pendingAmendments,
        age,
        stalled,
        activatedAt,
        lastHeartbeat,
        cycleCount: row.cycle_count ?? 0,
      };
    });

    return {
      hasData: true,
      tasks,
      totalActive,
      monitorsAlive,
      monitorsDead,
      pendingAmendments: totalPendingAmendments,
    };
  } catch {
    return EMPTY;
  } finally {
    try { db.close(); } catch { /* best-effort */ }
    try { if (todoDB) todoDB.close(); } catch { /* best-effort */ }
  }
}
