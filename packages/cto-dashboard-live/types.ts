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
  type: 'tool_call' | 'assistant_text' | 'tool_result' | 'error' | 'compaction' | 'session_end';
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
