/**
 * Persistent Task Monitor Data Reader
 *
 * Deep reader for the PersistentTaskMonitorSection. Queries:
 *   1. persistent-tasks.db — active/paused tasks with metadata, amendments, events
 *   2. session-queue.db   — running/queued items in persistent lane + by persistentTaskId
 *   3. todo.db            — linked sub-tasks for each persistent task
 *   4. agent-progress/*.json — pipeline progress for running agents
 *
 * All failures are non-fatal; missing data fields default to safe values.
 */

import * as fs from 'fs';
import * as path from 'path';
import { openReadonlyDb } from './readonly-db.js';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const PT_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
const SQ_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'session-queue.db');
const TODO_DB_PATH = path.join(PROJECT_DIR, '.claude', 'todo.db');
const PROGRESS_DIR = path.join(PROJECT_DIR, '.claude', 'state', 'agent-progress');

// ============================================================================
// Public Interfaces
// ============================================================================

export interface PersistentTaskMonitorAmendment {
  id: string;
  type: string;
  content: string;
  acknowledged: boolean;
  createdAt: string;
}

export interface PersistentTaskMonitorSubTask {
  id: string;
  title: string;
  status: string;
  section: string;
  agentId: string | null;
  agentElapsed: string | null;
  agentStage: string | null;
  agentProgressPct: number | null;
  prUrl: string | null;
  prMerged: boolean;
}

export interface PersistentTaskMonitorEvent {
  id: string;
  type: string;
  timestamp: string;
  details: string;
}

export interface PersistentTaskMonitorData {
  id: string;
  title: string;
  status: string;
  cycleCount: number;
  heartbeatAge: string;
  heartbeatStale: boolean;
  monitorPid: number | null;
  monitorAlive: boolean;
  queueStatus: string | null;       // 'queued' | 'running' | 'spawning' | null
  queueElapsed: string | null;
  amendments: PersistentTaskMonitorAmendment[];
  pendingAmendmentCount: number;
  subTasks: PersistentTaskMonitorSubTask[];
  recentEvents: PersistentTaskMonitorEvent[];
  demoInvolved: boolean;
  bridgeMainTree: boolean;
  activatedAt: string | null;
  age: string;
}

export interface PersistentTaskMonitorSectionData {
  hasData: boolean;
  tasks: PersistentTaskMonitorData[];
  totalActive: number;
  totalPaused: number;
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
  metadata: string | null;
}

interface AmendmentRow {
  id: string;
  amendment_type: string;
  content: string;
  acknowledged_at: string | null;
  created_at: string;
}

interface EventRow {
  id: string;
  event_type: string;
  details: string | null;
  created_at: string;
}

interface SubTaskLinkRow {
  todo_task_id: string;
}

interface TodoTaskRow {
  id: string;
  title: string;
  status: string;
  section: string;
}

interface QueueItemRow {
  id: string;
  status: string;
  agent_type: string;
  pid: number | null;
  spawned_at: string | null;
  enqueued_at: string;
  metadata: string | null;
}

interface AgentProgressFile {
  agentId?: string;
  taskId?: string;
  pipeline?: {
    currentStage?: string | null;
    progressPercent?: number;
  };
  worktree?: {
    branch?: string;
    commitCount?: number;
    prUrl?: string;
    prMerged?: boolean;
  };
  updatedAt?: string;
}

// ============================================================================
// Helpers
// ============================================================================

const EMPTY: PersistentTaskMonitorSectionData = {
  hasData: false,
  tasks: [],
  totalActive: 0,
  totalPaused: 0,
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

function formatElapsed(ms: number): string {
  if (ms < 0) return '0s';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return `${hours}h${remainMins > 0 ? ` ${remainMins}m` : ''}`;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isHeartbeatStale(lastHeartbeat: string | null): boolean {
  if (!lastHeartbeat) return true;
  const ms = Date.now() - new Date(lastHeartbeat).getTime();
  // Stale if no heartbeat in 15 minutes (persistent monitors heartbeat every ~5m)
  return ms > 15 * 60 * 1000;
}

function heartbeatAgeLabel(lastHeartbeat: string | null): string {
  if (!lastHeartbeat) return 'never';
  const ms = Date.now() - new Date(lastHeartbeat).getTime();
  if (ms < 0) return '0m';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return '0m';
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h`;
}

/**
 * Load all agent progress JSON files from the agent-progress directory.
 * Returns a map keyed by agentId.
 */
function loadAgentProgressMap(): Map<string, AgentProgressFile> {
  const result = new Map<string, AgentProgressFile>();
  if (!fs.existsSync(PROGRESS_DIR)) return result;

  let files: string[];
  try {
    files = fs.readdirSync(PROGRESS_DIR).filter(f => f.endsWith('.json'));
  } catch {
    return result;
  }

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(PROGRESS_DIR, file), 'utf8');
      const parsed: AgentProgressFile = JSON.parse(raw);
      const agentId = parsed.agentId ?? path.basename(file, '.json');
      result.set(agentId, parsed);
    } catch {
      // Non-fatal: skip malformed progress files
    }
  }

  return result;
}

/**
 * Load the agent progress file for a given task ID (via taskId field in progress file).
 * Returns the first matching progress file, or null.
 */
function findProgressByTaskId(taskId: string, progressMap: Map<string, AgentProgressFile>): AgentProgressFile | null {
  for (const prog of progressMap.values()) {
    if (prog.taskId === taskId) return prog;
  }
  return null;
}

// ============================================================================
// Main Reader
// ============================================================================

export function getPersistentTaskMonitorData(): PersistentTaskMonitorSectionData {
  if (!fs.existsSync(PT_DB_PATH)) return EMPTY;

  let ptDb: ReturnType<typeof openReadonlyDb> | null = null;
  let sqDb: ReturnType<typeof openReadonlyDb> | null = null;
  let todoDb: ReturnType<typeof openReadonlyDb> | null = null;

  try {
    try {
      ptDb = openReadonlyDb(PT_DB_PATH);
    } catch {
      return EMPTY;
    }

    // Load persistent tasks — active and paused only (not draft/completed/cancelled)
    const taskRows = ptDb.prepare(
      "SELECT id, title, status, monitor_pid, activated_at, last_heartbeat, cycle_count, metadata FROM persistent_tasks WHERE status IN ('active', 'paused') ORDER BY activated_at DESC"
    ).all() as PersistentTaskRow[];

    if (taskRows.length === 0) return EMPTY;

    // Open session-queue.db (non-critical)
    if (fs.existsSync(SQ_DB_PATH)) {
      try {
        sqDb = openReadonlyDb(SQ_DB_PATH);
      } catch {
        sqDb = null;
      }
    }

    // Open todo.db (non-critical)
    if (fs.existsSync(TODO_DB_PATH)) {
      try {
        todoDb = openReadonlyDb(TODO_DB_PATH);
      } catch {
        todoDb = null;
      }
    }

    // Load agent progress files once (shared across all tasks)
    const progressMap = loadAgentProgressMap();

    // Pre-load persistent lane queue items (for monitor queue status)
    const persistentQueueItems: QueueItemRow[] = sqDb
      ? (sqDb.prepare(
          "SELECT id, status, agent_type, pid, spawned_at, enqueued_at, metadata FROM queue_items WHERE lane = 'persistent' AND status IN ('queued', 'running', 'spawning') ORDER BY enqueued_at ASC"
        ).all() as QueueItemRow[])
      : [];

    let totalActive = 0;
    let totalPaused = 0;
    let monitorsAlive = 0;
    let monitorsDead = 0;
    let totalPendingAmendments = 0;

    const now = Date.now();

    const tasks: PersistentTaskMonitorData[] = taskRows.map(row => {
      if (row.status === 'active') totalActive++;
      else if (row.status === 'paused') totalPaused++;

      // PID liveness
      const monitorAlive = row.monitor_pid !== null && isPidAlive(row.monitor_pid);
      if (row.status === 'active') {
        if (monitorAlive) monitorsAlive++;
        else monitorsDead++;
      }

      // Parse metadata for demo_involved and bridge_main_tree flags
      let demoInvolved = false;
      let bridgeMainTree = false;
      if (row.metadata) {
        try {
          const meta = JSON.parse(row.metadata);
          demoInvolved = meta.demo_involved === true;
          bridgeMainTree = meta.bridge_main_tree === true;
        } catch {
          // Non-critical
        }
      }

      // Amendments (most recent 5, ordered newest first)
      let amendments: PersistentTaskMonitorAmendment[] = [];
      let pendingAmendmentCount = 0;
      try {
        const amendRows = ptDb!.prepare(
          "SELECT id, amendment_type, content, acknowledged_at, created_at FROM amendments WHERE persistent_task_id = ? ORDER BY created_at DESC LIMIT 5"
        ).all(row.id) as AmendmentRow[];
        amendments = amendRows.map(a => ({
          id: a.id,
          type: a.amendment_type,
          content: a.content.length > 120 ? a.content.substring(0, 117) + '...' : a.content,
          acknowledged: a.acknowledged_at !== null,
          createdAt: a.created_at,
        }));
        pendingAmendmentCount = amendRows.filter(a => a.acknowledged_at === null).length;
      } catch {
        // Non-critical
      }
      totalPendingAmendments += pendingAmendmentCount;

      // Recent events (last 5)
      let recentEvents: PersistentTaskMonitorEvent[] = [];
      try {
        const eventRows = ptDb!.prepare(
          "SELECT id, event_type, details, created_at FROM events WHERE persistent_task_id = ? ORDER BY created_at DESC LIMIT 5"
        ).all(row.id) as EventRow[];
        recentEvents = eventRows.map(e => ({
          id: e.id,
          type: e.event_type,
          timestamp: e.created_at,
          details: e.details ?? '',
        }));
      } catch {
        // Non-critical
      }

      // Sub-tasks from todo.db
      let subTasks: PersistentTaskMonitorSubTask[] = [];
      if (todoDb) {
        try {
          const linkRows = ptDb!.prepare(
            "SELECT todo_task_id FROM sub_tasks WHERE persistent_task_id = ? ORDER BY rowid ASC"
          ).all(row.id) as SubTaskLinkRow[];

          subTasks = linkRows.map(link => {
            let title = link.todo_task_id;
            let status = 'pending';
            let section = 'unknown';

            try {
              const todoRow = todoDb!.prepare(
                "SELECT id, title, status, section FROM tasks WHERE id = ?"
              ).get(link.todo_task_id) as TodoTaskRow | undefined;
              if (todoRow) {
                title = todoRow.title;
                status = todoRow.status;
                section = todoRow.section;
              } else {
                // Try archived tasks (completed tasks move there)
                const archived = todoDb!.prepare(
                  "SELECT id, title, 'completed' as status, section FROM archived_tasks WHERE id = ?"
                ).get(link.todo_task_id) as TodoTaskRow | undefined;
                if (archived) {
                  title = archived.title;
                  status = archived.status;
                  section = archived.section;
                }
              }
            } catch {
              // Non-critical
            }

            // Find agent progress for this sub-task
            let agentId: string | null = null;
            let agentElapsed: string | null = null;
            let agentStage: string | null = null;
            let agentProgressPct: number | null = null;
            let prUrl: string | null = null;
            let prMerged = false;

            if (status === 'in_progress') {
              const prog = findProgressByTaskId(link.todo_task_id, progressMap);
              if (prog) {
                agentId = prog.agentId ?? null;
                agentStage = prog.pipeline?.currentStage ?? null;
                agentProgressPct = prog.pipeline?.progressPercent ?? null;
                prUrl = prog.worktree?.prUrl ?? null;
                prMerged = prog.worktree?.prMerged ?? false;
                if (prog.updatedAt) {
                  agentElapsed = formatElapsed(now - new Date(prog.updatedAt).getTime());
                }
              }
            }

            return {
              id: link.todo_task_id,
              title,
              status,
              section,
              agentId,
              agentElapsed,
              agentStage,
              agentProgressPct,
              prUrl,
              prMerged,
            };
          });
        } catch {
          // Non-critical
        }
      }

      // Queue status for the monitor (check persistent lane for this task ID)
      let queueStatus: string | null = null;
      let queueElapsed: string | null = null;
      for (const qi of persistentQueueItems) {
        try {
          const meta = qi.metadata ? JSON.parse(qi.metadata) : {};
          if (meta.persistentTaskId === row.id) {
            queueStatus = qi.status;
            if (qi.spawned_at) {
              queueElapsed = formatElapsed(now - new Date(qi.spawned_at).getTime());
            } else if (qi.enqueued_at) {
              queueElapsed = formatElapsed(now - new Date(qi.enqueued_at).getTime());
            }
            break;
          }
        } catch {
          // Non-critical: skip malformed metadata
        }
      }

      return {
        id: row.id,
        title: row.title,
        status: row.status,
        cycleCount: row.cycle_count ?? 0,
        heartbeatAge: heartbeatAgeLabel(row.last_heartbeat),
        heartbeatStale: isHeartbeatStale(row.last_heartbeat),
        monitorPid: row.monitor_pid,
        monitorAlive,
        queueStatus,
        queueElapsed,
        amendments,
        pendingAmendmentCount,
        subTasks,
        recentEvents,
        demoInvolved,
        bridgeMainTree,
        activatedAt: row.activated_at,
        age: formatAge(row.activated_at),
      };
    });

    return {
      hasData: true,
      tasks,
      totalActive,
      totalPaused,
      monitorsAlive,
      monitorsDead,
      pendingAmendments: totalPendingAmendments,
    };
  } catch {
    return EMPTY;
  } finally {
    try { if (ptDb) ptDb.close(); } catch { /* best-effort */ }
    try { if (sqDb) sqDb.close(); } catch { /* best-effort */ }
    try { if (todoDb) todoDb.close(); } catch { /* best-effort */ }
  }
}
