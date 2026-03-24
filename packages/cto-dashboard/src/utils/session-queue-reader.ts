/**
 * Session Queue reader — reads queue data from .claude/state/session-queue.db
 */

import * as fs from 'fs';
import * as path from 'path';
import { openReadonlyDb } from './readonly-db.js';
import { getSessionActivity } from './session-activity-reader.js';

// ============================================================================
// Public Interfaces
// ============================================================================

export interface SessionQueueData {
  hasData: boolean;
  maxConcurrent: number;
  running: number;
  availableSlots: number;
  queuedItems: QueuedItem[];
  runningItems: RunningItem[];
  stats: QueueStats;
}

export interface QueuedItem {
  id: string;
  title: string;
  priority: string;
  lane: string;
  source: string;
  waitTime: string;
}

export interface RunningItem {
  id: string;
  title: string;
  source: string;
  agentType: string;
  pid: number;
  elapsed: string;
  lastTool: string | null;
  lastActivity: string | null;
  sessionId: string | null;
}

export interface QueueStats {
  completedLast24h: number;
  avgWaitSeconds: number;
  avgRunSeconds: number;
  bySource: Record<string, number>;
}

// ============================================================================
// Internal Row Types
// ============================================================================

interface QueueItemRow {
  id: string;
  status: string;
  priority: string;
  lane: string;
  title: string;
  agent_type: string;
  source: string;
  pid: number | null;
  enqueued_at: string;
  spawned_at: string | null;
  completed_at: string | null;
}

interface QueueConfigRow {
  value: string;
}

interface QueueCountRow {
  cnt: number;
}

interface QueueAvgRow {
  avg_secs: number | null;
}

interface QueueSourceRow {
  source: string;
  cnt: number;
}

// ============================================================================
// Constants
// ============================================================================

const EMPTY: SessionQueueData = {
  hasData: false,
  maxConcurrent: 10,
  running: 0,
  availableSlots: 10,
  queuedItems: [],
  runningItems: [],
  stats: { completedLast24h: 0, avgWaitSeconds: 0, avgRunSeconds: 0, bySource: {} },
};

// ============================================================================
// Helpers
// ============================================================================

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

// ============================================================================
// Main Reader
// ============================================================================

// ============================================================================
// Agent History Reader (for resolving agent_id from spawn timestamps)
// ============================================================================

interface AgentHistoryRecord {
  id: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

function readAgentHistory(projectDir: string): AgentHistoryRecord[] {
  const historyPath = path.join(projectDir, '.claude', 'state', 'agent-tracker-history.json');
  if (!fs.existsSync(historyPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    return Array.isArray(parsed?.agents) ? parsed.agents : [];
  } catch {
    return [];
  }
}

// ============================================================================
// Main Reader
// ============================================================================

export function getSessionQueueData(): SessionQueueData {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const dbPath = path.join(projectDir, '.claude', 'state', 'session-queue.db');

  if (!fs.existsSync(dbPath)) return EMPTY;

  let db;
  try {
    db = openReadonlyDb(dbPath);
  } catch {
    return EMPTY;
  }

  try {
    const now = Date.now();

    // Get config
    const configRow = db.prepare('SELECT value FROM queue_config WHERE key = ?').get('max_concurrent_sessions') as QueueConfigRow | undefined;
    const maxConcurrent = configRow ? parseInt(configRow.value, 10) : 10;

    // Get running items, filter to alive PIDs
    const runningRows = db.prepare("SELECT * FROM queue_items WHERE status = 'running' ORDER BY spawned_at ASC").all() as QueueItemRow[];
    const aliveRunning = runningRows.filter(r => r.pid !== null && isPidAlive(r.pid!));

    // Get queued items
    const queuedRows = db.prepare("SELECT * FROM queue_items WHERE status = 'queued' ORDER BY enqueued_at ASC").all() as QueueItemRow[];

    // 24h stats
    const completed24h = (db.prepare("SELECT COUNT(*) as cnt FROM queue_items WHERE status IN ('completed', 'failed') AND completed_at > datetime('now', '-24 hours')").get() as QueueCountRow).cnt;
    const avgWait = db.prepare("SELECT AVG(CAST((julianday(spawned_at) - julianday(enqueued_at)) * 86400 AS INTEGER)) as avg_secs FROM queue_items WHERE spawned_at IS NOT NULL AND enqueued_at IS NOT NULL AND spawned_at > datetime('now', '-24 hours')").get() as QueueAvgRow;
    const avgRun = db.prepare("SELECT AVG(CAST((julianday(completed_at) - julianday(spawned_at)) * 86400 AS INTEGER)) as avg_secs FROM queue_items WHERE completed_at IS NOT NULL AND spawned_at IS NOT NULL AND completed_at > datetime('now', '-24 hours')").get() as QueueAvgRow;
    const bySourceRows = db.prepare("SELECT source, COUNT(*) as cnt FROM queue_items WHERE enqueued_at > datetime('now', '-24 hours') GROUP BY source ORDER BY cnt DESC LIMIT 10").all() as QueueSourceRow[];

    // Load agent history for agent_id resolution
    const agentHistory = readAgentHistory(projectDir);

    return {
      hasData: true,
      maxConcurrent,
      running: aliveRunning.length,
      availableSlots: Math.max(0, maxConcurrent - aliveRunning.length),
      queuedItems: queuedRows.map(item => ({
        id: item.id,
        title: item.title,
        priority: item.priority,
        lane: item.lane,
        source: item.source,
        waitTime: formatElapsed(now - new Date(item.enqueued_at).getTime()),
      })),
      runningItems: aliveRunning.map(item => {
        const elapsed = item.spawned_at ? formatElapsed(now - new Date(item.spawned_at).getTime()) : 'unknown';

        // Attempt to resolve agent_id by matching spawn time from agent tracker history
        let agentId: string | null = null;
        if (item.spawned_at) {
          const spawnTime = new Date(item.spawned_at).getTime();
          const candidate = agentHistory.find(a => {
            const aTime = new Date(a.timestamp).getTime();
            return Math.abs(spawnTime - aTime) < 60_000;
          });
          if (candidate) agentId = candidate.id;
        }

        // Attempt to get live activity from the session JSONL
        let lastTool: string | null = null;
        let lastActivity: string | null = null;
        let sessionId: string | null = null;
        if (agentId) {
          try {
            const worktreePath = (() => {
              const record = agentHistory.find(a => a.id === agentId);
              return (record?.metadata?.worktreePath as string) ?? undefined;
            })();
            const activity = getSessionActivity(agentId, projectDir, worktreePath);
            if (activity) {
              lastTool = activity.lastTool;
              lastActivity = activity.lastTimestamp;
            }
          } catch {
            // Non-critical: session file may not yet exist or be readable
          }
        }

        return {
          id: item.id,
          title: item.title,
          source: item.source,
          agentType: item.agent_type,
          pid: item.pid!,
          elapsed,
          lastTool,
          lastActivity,
          sessionId,
        };
      }),
      stats: {
        completedLast24h: completed24h,
        avgWaitSeconds: Math.round(avgWait?.avg_secs ?? 0),
        avgRunSeconds: Math.round(avgRun?.avg_secs ?? 0),
        bySource: Object.fromEntries(bySourceRows.map(r => [r.source, r.cnt])),
      },
    };
  } finally {
    try { db.close(); } catch { /* best-effort */ }
  }
}
