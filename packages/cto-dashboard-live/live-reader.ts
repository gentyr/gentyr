/**
 * Live data reader — reads SQLite DBs and session JSONL files
 * to produce a LiveDashboardData snapshot.
 *
 * Self-contained: no imports from @gentyr/cto-dashboard.
 * All reads are best-effort; missing DBs produce empty data.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import Database from 'better-sqlite3';
import type {
  LiveDashboardData, SessionItem, PersistentTaskItem, SubTaskItem,
  WorklogEntry, QuotaData, DeputyCtoSummary, SystemStatusData,
  PlanItem, MetricsSummaryData, WorklogMetrics,
  Page2Data, Page3Data, TimelineEvent,
  SessionStatus, SessionPriority,
  DeputyCtoDetail, TriageReport, PendingQuestion, AnsweredQuestion,
  AccountInfo, FeedbackPersona, WorklogEntryDetail,
  TestingData, DeploymentItem, WorktreeInfo, InfraStatus, LoggingData,
  ActivityEntry,
} from './types.js';
import { formatElapsed } from './utils/formatters.js';

const PROJECT_DIR = path.resolve(process.env['CLAUDE_PROJECT_DIR'] || process.cwd());

// ============================================================================
// Helpers
// ============================================================================

function openDb(dbPath: string): Database.Database | null {
  if (!fs.existsSync(dbPath)) return null;
  try {
    return new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

function closeDb(db: Database.Database | null): void {
  try { if (db) db.close(); } catch { /* */ }
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function ageStr(isoOrNull: string | null): string {
  if (!isoOrNull) return '?';
  const ms = Date.now() - new Date(isoOrNull).getTime();
  return formatElapsed(Math.max(0, ms));
}

/** Read last N bytes of a file for JSONL tail parsing. */
function readTail(filePath: string, bytes = 8192): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    if (stat.size === 0) return '';
    const start = Math.max(0, stat.size - bytes);
    const buf = Buffer.alloc(Math.min(bytes, stat.size));
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* */ }
  }
}

/** Find session dir for this project under ~/.claude/projects/ */
function getSessionDir(): string | null {
  const encoded = PROJECT_DIR.replace(/[^a-zA-Z0-9]/g, '-');
  const base = path.join(os.homedir(), '.claude', 'projects');
  for (const variant of [encoded, encoded.replace(/^-/, '')]) {
    const p = path.join(base, variant);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Find a session JSONL file by [AGENT:id] marker in first 2KB. */
function findSessionFile(agentId: string): string | null {
  const dir = getSessionDir();
  if (!dir) return null;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(dir, f);
      const fd = fs.openSync(fp, 'r');
      const buf = Buffer.alloc(2048);
      const n = fs.readSync(fd, buf, 0, 2048, 0);
      fs.closeSync(fd);
      if (buf.toString('utf8', 0, n).includes(`[AGENT:${agentId}]`)) return fp;
    }
  } catch { /* */ }
  return null;
}

interface SessionSnapshot {
  tool: string | null;
  timestamp: string | null;
  lastMessage: string | null;
}

/** Extract last tool name, timestamp, and last assistant text from session JSONL tail. */
function getSessionSnapshot(agentId: string): SessionSnapshot {
  const file = findSessionFile(agentId);
  if (!file) return { tool: null, timestamp: null, lastMessage: null };
  const tail = readTail(file, 16384); // read more for message extraction
  const lines = tail.split('\n').filter(l => l.trim());
  let tool: string | null = null;
  let timestamp: string | null = null;
  let lastMessage: string | null = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type === 'assistant' && entry.message?.content) {
        const content = Array.isArray(entry.message.content) ? entry.message.content : [];
        for (const block of content) {
          if (!tool && block.type === 'tool_use') {
            tool = block.name ?? null;
            timestamp = entry.timestamp ?? null;
          }
          if (!lastMessage && block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 5) {
            // Get first meaningful line of assistant text
            const text = block.text.trim().split('\n').find((l: string) => l.trim().length > 5);
            if (text) lastMessage = text.trim().substring(0, 150);
          }
        }
      }
      if (tool && lastMessage) break;
    } catch { /* skip malformed */ }
  }
  return { tool, timestamp, lastMessage };
}

// ============================================================================
// Session Queue
// ============================================================================

interface QueueRow { id: string; status: string; priority: string; lane: string; title: string; agent_type: string; agent_id: string | null; source: string; pid: number | null; enqueued_at: string; spawned_at: string | null; completed_at: string | null; metadata: string | null; prompt: string | null; }

function readSessionQueue(): { queued: SessionItem[]; running: SessionItem[]; suspended: SessionItem[]; completed: SessionItem[]; maxConcurrent: number } {
  const db = openDb(path.join(PROJECT_DIR, '.claude', 'state', 'session-queue.db'));
  if (!db) return { queued: [], running: [], suspended: [], completed: [], maxConcurrent: 10 };
  try {
    const configRow = db.prepare("SELECT value FROM queue_config WHERE key = 'max_concurrent_sessions'").get() as { value: string } | undefined;
    const maxConcurrent = configRow ? parseInt(configRow.value, 10) : 10;

    const now = Date.now();
    const rows = db.prepare("SELECT * FROM queue_items WHERE status IN ('queued','running','spawning','suspended') ORDER BY enqueued_at ASC").all() as QueueRow[];
    // Get recently completed (initial batch)
    const doneRows = db.prepare("SELECT * FROM queue_items WHERE status IN ('completed','failed') ORDER BY completed_at DESC LIMIT 20").all() as QueueRow[];

    function toSession(row: QueueRow): SessionItem {
      // Use agent_id directly from queue_items (always populated for spawned sessions)
      const agentId: string | null = row.agent_id || null;
      const elapsed = row.spawned_at ? formatElapsed(now - new Date(row.spawned_at).getTime()) : formatElapsed(now - new Date(row.enqueued_at).getTime());
      const snapshot = agentId ? getSessionSnapshot(agentId) : { tool: null, timestamp: null, lastMessage: null };

      // Description: first 150 chars of prompt (useful for queued items)
      let description: string | null = null;
      if (row.prompt) {
        const firstLine = row.prompt.split('\n').find(l => l.trim().length > 5);
        description = firstLine ? firstLine.trim().substring(0, 150) : row.prompt.substring(0, 150);
      }

      return {
        id: row.id,
        status: (row.status === 'running' && row.pid && isPidAlive(row.pid) ? 'alive' : row.status === 'completed' ? 'completed' : row.status === 'failed' ? 'failed' : row.status) as SessionStatus,
        priority: row.priority as SessionPriority,
        agentType: row.agent_type || 'unknown',
        title: row.title || '',
        pid: row.pid,
        lastAction: snapshot.tool,
        lastActionTimestamp: snapshot.timestamp || row.spawned_at || row.enqueued_at,
        lastMessage: snapshot.lastMessage,
        description,
        killReason: null,
        totalTokens: null,
        sessionId: agentId || row.id,
        elapsed,
        worklog: null,
      };
    }

    const queued = rows.filter(r => r.status === 'queued').map(toSession);
    const running = rows.filter(r => r.status === 'running' || r.status === 'spawning').filter(r => r.pid && isPidAlive(r.pid!)).map(toSession);
    const suspended = rows.filter(r => r.status === 'suspended').map(toSession);
    const allCompleted = doneRows.map(r => {
      const s = toSession(r);
      s.worklog = findWorklog(r.id, r.metadata);
      return s;
    });

    // Deduplicate completed sessions with same title — keep most recent, append revival count
    const completedMap = new Map<string, { session: SessionItem; count: number }>();
    for (const s of allCompleted) {
      const key = s.title;
      const existing = completedMap.get(key);
      if (!existing) {
        completedMap.set(key, { session: s, count: 1 });
      } else {
        existing.count++;
      }
    }
    const completed = Array.from(completedMap.values()).map(({ session, count }) => {
      if (count > 1) {
        session.title = `${session.title} (${count}x)`;
      }
      return session;
    });

    return { queued, running, suspended, completed, maxConcurrent };
  } finally { closeDb(db); }
}

/**
 * Load more completed sessions for infinite scroll.
 * Returns deduplicated sessions starting from `offset`.
 */
export function readMoreCompleted(offset: number, limit: number): SessionItem[] {
  const db = openDb(path.join(PROJECT_DIR, '.claude', 'state', 'session-queue.db'));
  if (!db) return [];
  try {
    const now = Date.now();
    const rows = db.prepare("SELECT * FROM queue_items WHERE status IN ('completed','failed') ORDER BY completed_at DESC LIMIT ? OFFSET ?").all(limit + 10, offset) as QueueRow[];

    const sessions = rows.map(row => {
      // Use agent_id directly from queue_items (always populated for spawned sessions)
      const agentId: string | null = row.agent_id || null;
      const elapsed = row.spawned_at ? formatElapsed(now - new Date(row.spawned_at).getTime()) : '';
      const snapshot = agentId ? getSessionSnapshot(agentId) : { tool: null, timestamp: null, lastMessage: null };

      const s: SessionItem = {
        id: row.id,
        status: (row.status === 'completed' ? 'completed' : 'failed') as SessionStatus,
        priority: row.priority as SessionPriority,
        agentType: row.agent_type || 'unknown',
        title: row.title || '',
        pid: row.pid,
        lastAction: snapshot.tool,
        lastActionTimestamp: snapshot.timestamp || row.completed_at || row.spawned_at || row.enqueued_at,
        lastMessage: snapshot.lastMessage,
        description: null,
        killReason: null,
        totalTokens: null,
        sessionId: agentId || row.id,
        elapsed,
        worklog: findWorklog(row.id, row.metadata),
      };
      return s;
    });

    // Dedup by title
    const seen = new Map<string, { session: SessionItem; count: number }>();
    for (const s of sessions) {
      const existing = seen.get(s.title);
      if (!existing) seen.set(s.title, { session: s, count: 1 });
      else existing.count++;
    }
    return Array.from(seen.values()).map(({ session, count }) => {
      if (count > 1) session.title = `${session.title} (${count}x)`;
      return session;
    }).slice(0, limit);
  } finally { closeDb(db); }
}

function findWorklog(queueId: string, metadata: string | null): WorklogEntry | null {
  const db = openDb(path.join(PROJECT_DIR, '.claude', 'worklog.db'));
  if (!db) return null;
  try {
    // Try to match by task_id from metadata
    let taskId: string | null = null;
    try { if (metadata) taskId = JSON.parse(metadata).taskId ?? null; } catch { /* */ }
    if (!taskId) return null;
    const row = db.prepare('SELECT summary, success, duration_start_to_complete_ms, tokens_total FROM worklog_entries WHERE task_id = ? LIMIT 1').get(taskId) as { summary: string; success: number; duration_start_to_complete_ms: number | null; tokens_total: number | null } | undefined;
    if (!row) return null;
    return { summary: row.summary, success: row.success === 1, durationMs: row.duration_start_to_complete_ms, tokens: row.tokens_total };
  } finally { closeDb(db); }
}

// ============================================================================
// Persistent Tasks
// ============================================================================

function readPersistentTasks(runningSessions: SessionItem[]): PersistentTaskItem[] {
  const ptDb = openDb(path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db'));
  if (!ptDb) return [];
  const todoDb = openDb(path.join(PROJECT_DIR, '.claude', 'todo.db'));
  const queueDb = openDb(path.join(PROJECT_DIR, '.claude', 'state', 'session-queue.db'));
  try {
    const tasks = ptDb.prepare("SELECT id, title, status, monitor_pid, activated_at, last_heartbeat, cycle_count, metadata FROM persistent_tasks WHERE status IN ('active','paused') ORDER BY activated_at DESC").all() as Array<{ id: string; title: string; status: string; monitor_pid: number | null; activated_at: string | null; last_heartbeat: string | null; cycle_count: number | null; metadata: string | null }>;

    return tasks.map(t => {
      const monitorAlive = t.monitor_pid !== null && isPidAlive(t.monitor_pid);
      const hbMs = t.last_heartbeat ? Date.now() - new Date(t.last_heartbeat).getTime() : Infinity;
      let meta: Record<string, unknown> = {};
      try { if (t.metadata) meta = JSON.parse(t.metadata); } catch { /* */ }

      // Resolve the real agent_id from session-queue.db using the monitor PID
      let monitorAgentId: string | null = null;
      if (queueDb && t.monitor_pid) {
        try {
          const row = queueDb.prepare(
            "SELECT agent_id FROM queue_items WHERE pid = ? AND status = 'running' LIMIT 1",
          ).get(t.monitor_pid) as { agent_id: string } | undefined;
          monitorAgentId = row?.agent_id ?? null;
        } catch { /* */ }
      }

      // Monitor session
      const monitorSession: SessionItem = {
        id: `pt-monitor-${t.id}`,
        status: monitorAlive ? 'alive' : 'paused',
        priority: 'critical',
        agentType: 'persistent-monitor',
        title: `Monitor: ${t.title}`,
        pid: t.monitor_pid,
        lastAction: null,
        lastActionTimestamp: t.last_heartbeat || t.activated_at || new Date().toISOString(),
        lastMessage: null,
        description: null,
        killReason: null,
        totalTokens: null,
        sessionId: monitorAgentId || `pt-monitor-${t.id}`,
        elapsed: ageStr(t.activated_at),
        worklog: null,
      };

      // Sub-tasks — resolve titles, sort by status, limit displayed count
      let subTasks: SubTaskItem[] = [];
      if (todoDb) {
        try {
          const links = ptDb.prepare("SELECT todo_task_id FROM sub_tasks WHERE persistent_task_id = ?").all(t.id) as Array<{ todo_task_id: string }>;
          const allSubs = links.map(link => {
            let title = '', status = 'pending', section = '', resolved = false;
            try {
              const row = todoDb.prepare("SELECT title, status, section FROM tasks WHERE id = ?").get(link.todo_task_id) as { title: string; status: string; section: string } | undefined;
              if (row) { title = row.title; status = row.status; section = row.section; resolved = true; }
              else {
                const arch = todoDb.prepare("SELECT title, section FROM archived_tasks WHERE id = ?").get(link.todo_task_id) as { title: string; section: string } | undefined;
                if (arch) { title = arch.title; status = 'completed'; section = arch.section; resolved = true; }
              }
            } catch { /* */ }

            // Skip sub-tasks where title couldn't be resolved (raw UUIDs)
            if (!resolved) return null;

            let session: SessionItem | null = null;
            if (status === 'in_progress') {
              session = runningSessions.find(s => s.title.includes(title.substring(0, 20))) ?? null;
            }

            return {
              id: link.todo_task_id,
              title, status, section,
              session,
              agentStage: null,
              agentProgressPct: null,
              prUrl: null,
              prMerged: false,
              worklog: status === 'completed' ? findWorklog('', `{"taskId":"${link.todo_task_id}"}`) : null,
            };
          }).filter(Boolean) as SubTaskItem[];

          // Sort: in_progress first, then completed (most recent first), then pending
          const statusOrder: Record<string, number> = { in_progress: 0, completed: 1, pending: 2, pending_review: 3 };
          allSubs.sort((a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9));

          // Limit: show all in_progress + up to 8 completed + count of pending
          const active = allSubs.filter((s: SubTaskItem) => s.status === 'in_progress');
          const done = allSubs.filter((s: SubTaskItem) => s.status === 'completed').slice(0, 8);
          const pendingCount = allSubs.filter((s: SubTaskItem) => s.status === 'pending' || s.status === 'pending_review').length;

          subTasks = [...active, ...done];
          // Add a synthetic "N pending" summary if there are pending items
          if (pendingCount > 0) {
            subTasks.push({
              id: `pending-summary-${t.id}`,
              title: `${pendingCount} pending task${pendingCount !== 1 ? 's' : ''}`,
              status: 'pending',
              section: '',
              session: null,
              agentStage: null,
              agentProgressPct: null,
              prUrl: null,
              prMerged: false,
              worklog: null,
            });
          }
        } catch { /* */ }
      }

      return {
        id: t.id,
        title: t.title,
        status: t.status,
        age: ageStr(t.activated_at),
        cycleCount: t.cycle_count ?? 0,
        heartbeatAge: t.last_heartbeat ? ageStr(t.last_heartbeat) : 'never',
        heartbeatStale: hbMs > 15 * 60 * 1000,
        demoInvolved: meta.demo_involved === true,
        bridgeMainTree: meta.bridge_main_tree === true,
        monitorSession,
        subTasks,
      };
    });
  } finally {
    closeDb(ptDb);
    closeDb(todoDb);
  }
}

// ============================================================================
// Right Panel Data
// ============================================================================

function readQuota(): QuotaData {
  try {
    const rotPath = path.join(os.homedir(), '.claude', 'api-key-rotation.json');
    if (!fs.existsSync(rotPath)) return { fiveHourPct: 0, sevenDayPct: 0, activeAccounts: 0, rotationEvents24h: 0 };
    const data = JSON.parse(fs.readFileSync(rotPath, 'utf8'));
    return {
      fiveHourPct: data.aggregate?.five_hour?.utilization ?? 0,
      sevenDayPct: data.aggregate?.seven_day?.utilization ?? 0,
      activeAccounts: data.healthy_count ?? (Array.isArray(data.keys) ? new Set(data.keys.filter((k: { status: string }) => k.status === 'active').map((k: { email: string }) => k.email)).size : 0),
      rotationEvents24h: 0,
    };
  } catch { return { fiveHourPct: 0, sevenDayPct: 0, activeAccounts: 0, rotationEvents24h: 0 }; }
}

function readDeputyCtoSummary(): DeputyCtoSummary {
  const db = openDb(path.join(PROJECT_DIR, '.claude', 'cto-reports.db'));
  const dcDb = openDb(path.join(PROJECT_DIR, '.claude', 'deputy-cto.db'));
  try {
    let untriaged = 0, escalated = 0, handled24h = 0, dismissed24h = 0;
    if (db) {
      untriaged = ((db.prepare("SELECT COUNT(*) as c FROM reports WHERE triage_status = 'pending'").get() as { c: number })?.c) ?? 0;
      escalated = ((db.prepare("SELECT COUNT(*) as c FROM reports WHERE triage_status = 'escalated'").get() as { c: number })?.c) ?? 0;
      handled24h = ((db.prepare("SELECT COUNT(*) as c FROM reports WHERE triage_status = 'self_handled' AND triage_completed_at > datetime('now','-24 hours')").get() as { c: number })?.c) ?? 0;
      dismissed24h = ((db.prepare("SELECT COUNT(*) as c FROM reports WHERE triage_status = 'dismissed' AND triage_completed_at > datetime('now','-24 hours')").get() as { c: number })?.c) ?? 0;
    }
    let pendingQ = 0;
    if (dcDb) {
      pendingQ = ((dcDb.prepare("SELECT COUNT(*) as c FROM questions WHERE status = 'pending'").get() as { c: number })?.c) ?? 0;
    }
    return { untriagedCount: untriaged, escalatedCount: escalated, pendingQuestionCount: pendingQ, handled24h, dismissed24h };
  } catch { return { untriagedCount: 0, escalatedCount: 0, pendingQuestionCount: 0, handled24h: 0, dismissed24h: 0 }; }
  finally { closeDb(db); closeDb(dcDb); }
}

function readSystemStatus(): SystemStatusData {
  let deputyEnabled = false, interval = 15;
  try {
    const cfgPath = path.join(PROJECT_DIR, '.claude', 'autonomous-mode.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      deputyEnabled = cfg.enabled === true;
      interval = cfg.interval_minutes ?? 15;
    }
  } catch { /* */ }
  return { deputyEnabled, deputyIntervalMinutes: interval, protectionStatus: 'unknown', commitsBlocked: false };
}

function readPlans(): PlanItem[] {
  const db = openDb(path.join(PROJECT_DIR, '.claude', 'state', 'plans.db'));
  if (!db) return [];
  try {
    const rows = db.prepare("SELECT id, title, status FROM plans WHERE status IN ('active','draft') ORDER BY created_at DESC LIMIT 5").all() as Array<{ id: string; title: string; status: string }>;
    return rows.map(r => {
      const taskCount = ((db.prepare("SELECT COUNT(*) as c FROM plan_tasks WHERE plan_id = ?").get(r.id) as { c: number })?.c) ?? 0;
      const completedTasks = ((db.prepare("SELECT COUNT(*) as c FROM plan_tasks WHERE plan_id = ? AND status = 'completed'").get(r.id) as { c: number })?.c) ?? 0;
      const readyTasks = ((db.prepare("SELECT COUNT(*) as c FROM plan_tasks WHERE plan_id = ? AND status = 'ready'").get(r.id) as { c: number })?.c) ?? 0;
      const pct = taskCount > 0 ? Math.round((completedTasks / taskCount) * 100) : 0;
      return { id: r.id, title: r.title, status: r.status, progressPct: pct, completedTasks, totalTasks: taskCount, readyTasks };
    });
  } catch { return []; }
  finally { closeDb(db); }
}

function readMetrics(): MetricsSummaryData {
  const db = openDb(path.join(PROJECT_DIR, '.claude', 'todo.db'));
  if (!db) return { tokensIn: 0, tokensOut: 0, cacheRate: 0, tasksPending: 0, tasksActive: 0, tasksDone24h: 0, hooksTotal: 0, hooksSuccessRate: 0, triagePending: 0, triageHandled24h: 0, cooldownFactor: 1, cooldownTargetPct: 80 };
  try {
    const pending = ((db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status = 'pending'").get() as { c: number })?.c) ?? 0;
    const active = ((db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status = 'in_progress'").get() as { c: number })?.c) ?? 0;
    const done = ((db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status = 'completed' AND completed_timestamp > ?").get(Math.floor((Date.now() - 86400000) / 1000)) as { c: number })?.c) ?? 0;
    return { tokensIn: 0, tokensOut: 0, cacheRate: 0, tasksPending: pending, tasksActive: active, tasksDone24h: done, hooksTotal: 0, hooksSuccessRate: 0, triagePending: 0, triageHandled24h: 0, cooldownFactor: 1, cooldownTargetPct: 80 };
  } catch { return { tokensIn: 0, tokensOut: 0, cacheRate: 0, tasksPending: 0, tasksActive: 0, tasksDone24h: 0, hooksTotal: 0, hooksSuccessRate: 0, triagePending: 0, triageHandled24h: 0, cooldownFactor: 1, cooldownTargetPct: 80 }; }
  finally { closeDb(db); }
}

function readWorklogMetrics(): { metrics: WorklogMetrics; entries: WorklogEntryDetail[] } {
  const db = openDb(path.join(PROJECT_DIR, '.claude', 'worklog.db'));
  if (!db) return { metrics: { successRatePct: null, avgCompleteMs: null, coveragePct: 0, cacheHitPct: null, entries: 0, completedTasks: 0 }, entries: [] };
  try {
    const rows = db.prepare('SELECT id, task_id, section, title, summary, success, duration_start_to_complete_ms, tokens_total, created_at FROM worklog_entries ORDER BY created_at DESC LIMIT 30').all() as Array<{ id: string; task_id: string; section: string; title: string; summary: string; success: number; duration_start_to_complete_ms: number | null; tokens_total: number | null; created_at: string }>;
    const entries: WorklogEntryDetail[] = rows.map(r => ({
      id: r.id, section: r.section, title: r.title, success: r.success === 1,
      durationMs: r.duration_start_to_complete_ms, tokens: r.tokens_total, createdAt: r.created_at,
    }));
    const total = rows.length;
    const succCount = rows.filter(r => r.success === 1).length;
    const avgMs = total > 0 ? Math.round(rows.reduce((s, r) => s + (r.duration_start_to_complete_ms ?? 0), 0) / total) : null;
    return {
      metrics: { successRatePct: total > 0 ? Math.round((succCount / total) * 100) : null, avgCompleteMs: avgMs, coveragePct: 0, cacheHitPct: null, entries: total, completedTasks: 0 },
      entries,
    };
  } catch { return { metrics: { successRatePct: null, avgCompleteMs: null, coveragePct: 0, cacheHitPct: null, entries: 0, completedTasks: 0 }, entries: [] }; }
  finally { closeDb(db); }
}

// ============================================================================
// Page 2 Data
// ============================================================================

function readPage2(): Page2Data {
  const depSummary = readDeputyCtoSummary();
  const { metrics, entries } = readWorklogMetrics();

  // Deputy CTO detail
  let deputyCto: DeputyCtoDetail = { hasData: false, untriaged: [], escalated: [], recentlyTriaged: [], pendingQuestions: [], answeredQuestions: [], handled24h: 0, escalated24h: 0, dismissed24h: 0 };
  const ctoDb = openDb(path.join(PROJECT_DIR, '.claude', 'cto-reports.db'));
  const dcDb = openDb(path.join(PROJECT_DIR, '.claude', 'deputy-cto.db'));
  try {
    if (ctoDb) {
      const untriaged = ctoDb.prepare("SELECT id, title, priority, triage_status, created_at FROM reports WHERE triage_status = 'pending' ORDER BY created_at DESC LIMIT 10").all() as Array<{ id: string; title: string; priority: string; triage_status: string; created_at: string }>;
      const escalated = ctoDb.prepare("SELECT id, title, priority, triage_status, created_at FROM reports WHERE triage_status = 'escalated' ORDER BY created_at DESC LIMIT 5").all() as Array<{ id: string; title: string; priority: string; triage_status: string; created_at: string }>;
      const triaged = ctoDb.prepare("SELECT id, title, priority, triage_status, triage_outcome, created_at FROM reports WHERE triage_status IN ('self_handled','escalated','dismissed') AND triage_completed_at > datetime('now','-24 hours') ORDER BY triage_completed_at DESC LIMIT 8").all() as Array<{ id: string; title: string; priority: string; triage_status: string; triage_outcome: string | null; created_at: string }>;
      deputyCto = {
        hasData: true,
        untriaged: untriaged.map(r => ({ id: r.id, title: r.title, priority: r.priority, status: r.triage_status, createdAt: r.created_at })),
        escalated: escalated.map(r => ({ id: r.id, title: r.title, priority: r.priority, status: r.triage_status, createdAt: r.created_at })),
        recentlyTriaged: triaged.map(r => ({ id: r.id, title: r.title, priority: r.priority, status: r.triage_status, createdAt: r.created_at, outcome: r.triage_outcome ?? undefined })),
        pendingQuestions: [],
        answeredQuestions: [],
        handled24h: depSummary.handled24h,
        escalated24h: depSummary.escalatedCount,
        dismissed24h: depSummary.dismissed24h,
      };
    }
    if (dcDb) {
      const pq = dcDb.prepare("SELECT id, title, type, created_at, recommendation FROM questions WHERE status = 'pending' ORDER BY created_at DESC LIMIT 10").all() as Array<{ id: string; title: string; type: string; created_at: string; recommendation: string | null }>;
      deputyCto.pendingQuestions = pq.map(q => ({ id: q.id, title: q.title, type: q.type, createdAt: q.created_at, recommendation: q.recommendation }));
    }
  } catch { /* */ }
  finally { closeDb(ctoDb); closeDb(dcDb); }

  // Accounts (from rotation state)
  let accounts: AccountInfo[] = [];
  try {
    const rotPath = path.join(os.homedir(), '.claude', 'api-key-rotation.json');
    if (fs.existsSync(rotPath)) {
      const data = JSON.parse(fs.readFileSync(rotPath, 'utf8'));
      if (Array.isArray(data.keys)) {
        const seen = new Set<string>();
        for (const k of data.keys) {
          if (seen.has(k.email)) continue;
          seen.add(k.email);
          accounts.push({ email: k.email, status: k.status ?? 'unknown', subscription: k.subscription_type ?? '', fiveHourPct: 0, sevenDayPct: 0 });
        }
      }
    }
  } catch { /* */ }

  // Personas
  let personas: FeedbackPersona[] = [];
  const fbDb = openDb(path.join(PROJECT_DIR, '.claude', 'user-feedback.db'));
  if (fbDb) {
    try {
      const rows = fbDb.prepare("SELECT name, consumption_modes, enabled FROM personas ORDER BY name").all() as Array<{ name: string; consumption_modes: string; enabled: number }>;
      personas = rows.map(r => ({ name: r.name, consumptionModes: r.consumption_modes, enabled: r.enabled === 1, sessionCount: 0, lastSatisfaction: null, findingsCount: 0 }));
    } catch { /* */ }
    finally { closeDb(fbDb); }
  }

  return {
    accounts, deputyCto, personas,
    productManagerEnabled: false, productManagerSectionsCompleted: 0,
    worklogEntries: entries, worklogMetrics: metrics,
  };
}

// ============================================================================
// Page 3 Data (Infrastructure)
// ============================================================================

function readPage3(): Page3Data {
  // Worktrees
  let worktrees: WorktreeInfo[] = [];
  const wtDir = path.join(PROJECT_DIR, '.claude', 'worktrees');
  if (fs.existsSync(wtDir)) {
    try {
      for (const d of fs.readdirSync(wtDir)) {
        const wp = path.join(wtDir, d);
        if (!fs.statSync(wp).isDirectory()) continue;
        const stat = fs.statSync(wp);
        const age = formatElapsed(Date.now() - stat.mtimeMs);
        worktrees.push({ branch: d, path: wp, age, hasChanges: false });
      }
    } catch { /* */ }
  }

  return {
    testing: { hasData: false, totalTests: 0, passing: 0, failing: 0, skipped: 0, coveragePct: null },
    deployments: [],
    worktrees,
    infra: { renderServices: 0, renderSuspended: 0, vercelProjects: 0, supabaseHealthy: false, cloudflareStatus: 'unknown' },
    logging: { totalLogs1h: 0, totalLogs24h: 0, errorCount1h: 0, warnCount1h: 0 },
    timeline: [],
  };
}

// ============================================================================
// Main
// ============================================================================

export function readLiveData(): LiveDashboardData {
  const { queued, running, suspended, completed, maxConcurrent } = readSessionQueue();
  const persistentTasks = readPersistentTasks(running);

  // Filter out sessions that belong to persistent tasks (by PID match or title match)
  const ptPids = new Set<number>();
  const ptTitlePrefixes = new Set<string>();
  for (const pt of persistentTasks) {
    if (pt.monitorSession.pid) ptPids.add(pt.monitorSession.pid);
    ptTitlePrefixes.add(pt.title.substring(0, 30));
    for (const st of pt.subTasks) {
      if (st.session?.pid) ptPids.add(st.session.pid);
    }
  }
  const standaloneRunning = running.filter(s => {
    if (s.pid && ptPids.has(s.pid)) return false;
    // Also filter revival/monitor sessions by title match
    if (s.title.includes('[Persistent]') || s.title.includes('Monitor revival') || s.title.includes('Stale-pause revival')) {
      for (const prefix of ptTitlePrefixes) {
        if (s.title.includes(prefix)) return false;
      }
    }
    return true;
  });

  const totalRunning = running.length;
  const { metrics: worklogMetrics, entries: worklogEntries } = readWorklogMetrics();

  const page2 = readPage2();
  // Override with the already-read worklog data
  page2.worklogEntries = worklogEntries;
  page2.worklogMetrics = worklogMetrics;

  // Also filter completed sessions that are PT monitor revivals
  const standaloneCompleted = completed.filter(s => {
    for (const prefix of ptTitlePrefixes) {
      if (s.title.includes(prefix) && (s.title.includes('Monitor revival') || s.title.includes('Stale-pause revival'))) return false;
    }
    return true;
  });

  return {
    queuedSessions: queued,
    persistentTasks,
    runningSessions: standaloneRunning,
    suspendedSessions: suspended,
    completedSessions: standaloneCompleted,
    capacity: { running: totalRunning, max: maxConcurrent },
    quota: readQuota(),
    deputyCtoSummary: readDeputyCtoSummary(),
    systemStatus: readSystemStatus(),
    plans: readPlans(),
    metricsSummary: readMetrics(),
    worklogMetrics,
    page2,
    page3: readPage3(),
    pageAnalytics: { usage: { hasData: false, fiveHourSnapshots: [], sevenDaySnapshots: [], cooldownFactor: 1, targetPct: 80, projectedAtResetPct: null }, automatedInstances: [] },
  };
}

// ============================================================================
// Page 4: Session Tail + Signal
// ============================================================================

/**
 * Parse JSONL content from a byte position range into ActivityEntry[].
 * Returns parsed entries and the new file position (byte offset).
 */
export function readSessionTail(
  agentId: string,
  fromPosition?: number,
): { entries: ActivityEntry[]; newPosition: number } {
  const file = findSessionFile(agentId);
  if (!file) return { entries: [], newPosition: 0 };

  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;
    if (fileSize === 0) return { entries: [], newPosition: 0 };

    const startPos = fromPosition !== undefined ? Math.min(fromPosition, fileSize) : Math.max(0, fileSize - 65536);
    const bytesToRead = fileSize - startPos;
    if (bytesToRead <= 0) return { entries: [], newPosition: fileSize };

    const buf = Buffer.alloc(bytesToRead);
    fs.readSync(fd, buf, 0, bytesToRead, startPos);
    const text = buf.toString('utf8');

    const lines = text.split('\n');
    const entries: ActivityEntry[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }

      const timestamp = (typeof parsed['timestamp'] === 'string' ? parsed['timestamp'] : new Date().toISOString());

      // Compaction boundary marker
      if (parsed['type'] === 'compact_boundary') {
        entries.push({ type: 'compaction', timestamp, text: '[context compacted]' });
        continue;
      }

      // Assistant message — extract tool_use and text blocks
      if (parsed['type'] === 'assistant') {
        const msg = parsed['message'] as Record<string, unknown> | undefined;
        const content = Array.isArray(msg?.['content']) ? (msg!['content'] as unknown[]) : [];
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b['type'] === 'tool_use') {
            const toolName = typeof b['name'] === 'string' ? b['name'] : 'unknown';
            const inputObj = b['input'];
            let toolInput = '';
            if (inputObj && typeof inputObj === 'object') {
              // Show first meaningful key/value as preview
              const keys = Object.keys(inputObj as object);
              const firstKey = keys[0];
              if (firstKey) {
                const val = (inputObj as Record<string, unknown>)[firstKey];
                const valStr = typeof val === 'string' ? val : JSON.stringify(val);
                toolInput = `${firstKey}: ${valStr.substring(0, 60)}`;
                if (keys.length > 1) toolInput += ` +${keys.length - 1}`;
              }
            }
            entries.push({
              type: 'tool_call',
              timestamp,
              text: toolName,
              toolName,
              toolInput,
            });
          } else if (b['type'] === 'text') {
            const textVal = typeof b['text'] === 'string' ? b['text'] : '';
            const preview = textVal.trim().split('\n').find((l: string) => l.trim().length > 3) ?? textVal;
            if (preview.trim().length > 0) {
              entries.push({
                type: 'assistant_text',
                timestamp,
                text: preview.trim().substring(0, 200),
              });
            }
          }
        }
        continue;
      }

      // Tool result
      if (parsed['type'] === 'tool_result') {
        const content = parsed['content'];
        let preview = '';
        if (typeof content === 'string') {
          preview = content.trim().substring(0, 150);
        } else if (Array.isArray(content)) {
          for (const c of content as unknown[]) {
            const cb = c as Record<string, unknown>;
            if (cb['type'] === 'text' && typeof cb['text'] === 'string') {
              preview = cb['text'].trim().substring(0, 150);
              break;
            }
          }
        }
        if (preview) {
          entries.push({
            type: 'tool_result',
            timestamp,
            text: preview,
            resultPreview: preview,
          });
        }
        continue;
      }

      // Error messages
      if (parsed['type'] === 'error' || (typeof parsed['error'] === 'string' && parsed['error'])) {
        const errMsg = typeof parsed['error'] === 'string'
          ? parsed['error']
          : JSON.stringify(parsed).substring(0, 150);
        entries.push({ type: 'error', timestamp, text: errMsg });
        continue;
      }
    }

    return { entries, newPosition: fileSize };
  } catch {
    return { entries: [], newPosition: fromPosition ?? 0 };
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* */ }
  }
}

/**
 * Check whether a process with the given PID is alive.
 * Uses POSIX signal 0 — does not actually send a signal.
 */
export function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Open a new Terminal.app window and resume the given Claude session with an
 * initial message.  Best-effort: failures are swallowed so the TUI stays alive.
 */
export function resumeSessionWithMessage(sessionId: string, message: string): void {
  const projectDir = process.env['CLAUDE_PROJECT_DIR'] || process.cwd();
  // Escape backslashes first, then double-quotes, so the final shell string
  // is safe inside the outer AppleScript double-quoted string literal.
  const escaped = message.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const cmd = `cd "${projectDir}" && claude --resume "${sessionId}" -p "${escaped}"`;
  try {
    execFileSync('osascript', [
      '-e',
      `tell application "Terminal"\ndo script "${cmd}"\nactivate\nend tell`,
    ], { timeout: 10000, stdio: 'pipe' });
  } catch { /* best effort — TUI must not crash */ }
}

/**
 * Write a directive signal JSON file to the session-signals directory.
 * Uses atomic tmp+rename to avoid partial reads.
 * Returns true on success, throws on failure.
 */
export function sendDirectiveSignal(toAgentId: string, message: string): boolean {
  const signalDir = path.join(PROJECT_DIR, '.claude', 'state', 'session-signals');
  fs.mkdirSync(signalDir, { recursive: true });
  const id = `sig-${crypto.randomUUID().slice(0, 8)}`;
  const filename = `${toAgentId}-${Date.now()}-${id}.json`;
  const signal = {
    id,
    from_agent_id: 'cto-dashboard',
    from_agent_type: 'cto',
    from_task_title: 'CTO Dashboard Signal',
    to_agent_id: toAgentId,
    to_agent_type: 'agent',
    tier: 'directive',
    message,
    created_at: new Date().toISOString(),
    read_at: null,
    acknowledged_at: null,
  };
  const tmpPath = path.join(signalDir, `.${filename}.tmp`);
  fs.writeFileSync(tmpPath, JSON.stringify(signal));
  fs.renameSync(tmpPath, path.join(signalDir, filename));
  // Append to comms log (best-effort)
  try {
    fs.appendFileSync(
      path.join(PROJECT_DIR, '.claude', 'state', 'session-comms.log'),
      JSON.stringify(signal) + '\n',
    );
  } catch { /* non-fatal */ }
  return true;
}

/**
 * Read LLM-generated summaries for a specific agent from session-activity.db.
 * Returns summaries in chronological order (oldest first).
 */
export function getSessionSummaries(agentId: string): Array<{ id: string; summary: string; created_at: string }> {
  const dbPath = path.join(PROJECT_DIR, '.claude', 'state', 'session-activity.db');
  if (!fs.existsSync(dbPath)) return [];
  let db: InstanceType<typeof Database> | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    return db.prepare(
      'SELECT id, summary, created_at FROM session_summaries WHERE agent_id = ? ORDER BY created_at ASC',
    ).all(agentId) as Array<{ id: string; summary: string; created_at: string }>;
  } catch { return []; }
  finally { try { db?.close(); } catch { /* */ } }
}
