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
import { execFileSync, spawn } from 'child_process';
import Database from 'better-sqlite3';
import type {
  LiveDashboardData, SessionItem, PersistentTaskItem, SubTaskItem,
  WorklogEntry, SessionStatus, SessionPriority, ActivityEntry,
  DemoScenarioItem, TestFileItem, Page2Data,
  Page3Data, PlanItem, PlanPhaseItem, PlanTaskItem, PlanSubstepItem, PlanStateChange,
  Page4Data, SpecCategoryItem, SpecItem, SuiteItem,
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

/** Check whether a process with the given PID is alive (POSIX signal 0). */
export function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Parse a SQLite datetime string as UTC.
 * SQLite's datetime('now') produces "YYYY-MM-DD HH:MM:SS" (UTC, no Z suffix).
 * JavaScript's new Date() parses this as local time without timezone indicator.
 * This helper ensures correct UTC interpretation.
 */
function parseSqliteDatetime(str: string | null): Date {
  if (!str) return new Date(NaN);
  if (str.includes('T')) return new Date(str);
  return new Date(str.replace(' ', 'T') + 'Z');
}

function ageStr(isoOrNull: string | null): string {
  if (!isoOrNull) return '?';
  const ms = Date.now() - parseSqliteDatetime(isoOrNull).getTime();
  return formatElapsed(Math.max(0, ms));
}

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

function getSessionDirForPath(dirPath: string): string | null {
  const encoded = dirPath.replace(/[^a-zA-Z0-9]/g, '-');
  const base = path.join(os.homedir(), '.claude', 'projects');
  for (const variant of [encoded, encoded.replace(/^-/, '')]) {
    const p = path.join(base, variant);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function getSessionDir(): string | null {
  return getSessionDirForPath(PROJECT_DIR);
}

export function findSessionFile(agentId: string, worktreePath?: string | null): string | null {
  const marker = `[AGENT:${agentId}]`;

  function searchDir(dir: string): string | null {
    try {
      const files = fs.readdirSync(dir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 50);

      for (const { name } of files) {
        const fp = path.join(dir, name);
        let fd: number | undefined;
        try {
          fd = fs.openSync(fp, 'r');
          const stat = fs.fstatSync(fd);
          const fileSize = stat.size;
          const headSize = Math.min(8192, fileSize);
          const headBuf = Buffer.alloc(headSize);
          fs.readSync(fd, headBuf, 0, headSize, 0);
          if (headBuf.toString('utf8').includes(marker)) { fs.closeSync(fd); return fp; }
          if (fileSize > 8192) {
            const tailSize = Math.min(16384, fileSize - headSize);
            const tailBuf = Buffer.alloc(tailSize);
            fs.readSync(fd, tailBuf, 0, tailSize, fileSize - tailSize);
            if (tailBuf.toString('utf8').includes(marker)) { fs.closeSync(fd); return fp; }
          }
          fs.closeSync(fd);
        } catch {
          if (fd !== undefined) try { fs.closeSync(fd); } catch { /* */ }
        }
      }
    } catch { /* */ }
    return null;
  }

  if (worktreePath) {
    const wtDir = getSessionDirForPath(worktreePath);
    if (wtDir) { const found = searchDir(wtDir); if (found) return found; }
  }
  const mainDir = getSessionDir();
  return mainDir ? searchDir(mainDir) : null;
}

interface SessionSnapshot { tool: string | null; timestamp: string | null; lastMessage: string | null; }

function getSessionSnapshot(agentId: string, worktreePath?: string | null): SessionSnapshot {
  const file = findSessionFile(agentId, worktreePath);
  if (!file) return { tool: null, timestamp: null, lastMessage: null };
  const tail = readTail(file, 16384);
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
          if (!tool && block.type === 'tool_use') { tool = block.name ?? null; timestamp = entry.timestamp ?? null; }
          if (!lastMessage && block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 5) {
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

interface QueueRow { id: string; status: string; priority: string; lane: string; title: string; agent_type: string; agent_id: string | null; source: string; pid: number | null; enqueued_at: string; spawned_at: string | null; completed_at: string | null; metadata: string | null; prompt: string | null; worktree_path: string | null; }

function readSessionQueue(): { queued: SessionItem[]; running: SessionItem[]; suspended: SessionItem[]; completed: SessionItem[]; maxConcurrent: number } {
  const db = openDb(path.join(PROJECT_DIR, '.claude', 'state', 'session-queue.db'));
  if (!db) return { queued: [], running: [], suspended: [], completed: [], maxConcurrent: 10 };
  try {
    const configRow = db.prepare("SELECT value FROM queue_config WHERE key = 'max_concurrent_sessions'").get() as { value: string } | undefined;
    const maxConcurrent = configRow ? parseInt(configRow.value, 10) : 10;
    const now = Date.now();
    const rows = db.prepare("SELECT * FROM queue_items WHERE status IN ('queued','running','spawning','suspended') ORDER BY enqueued_at ASC").all() as QueueRow[];
    const doneRows = db.prepare("SELECT * FROM queue_items WHERE status IN ('completed','failed') ORDER BY completed_at DESC LIMIT 20").all() as QueueRow[];

    function toSession(row: QueueRow): SessionItem {
      const agentId: string | null = row.agent_id || null;
      const worktreePath: string | null = row.worktree_path || null;
      let elapsed: string;
      if (row.status === 'completed' || row.status === 'failed') {
        const start = parseSqliteDatetime(row.spawned_at ?? row.enqueued_at);
        const end = parseSqliteDatetime(row.completed_at);
        elapsed = isNaN(end.getTime()) || isNaN(start.getTime()) ? '?' : formatElapsed(Math.max(0, end.getTime() - start.getTime()));
      } else {
        const start = parseSqliteDatetime(row.spawned_at ?? row.enqueued_at);
        elapsed = isNaN(start.getTime()) ? '?' : formatElapsed(Math.max(0, now - start.getTime()));
      }
      const snapshot = agentId ? getSessionSnapshot(agentId, worktreePath) : { tool: null, timestamp: null, lastMessage: null };
      let description: string | null = null;
      if (row.prompt) {
        const firstLine = row.prompt.split('\n').find(l => l.trim().length > 5);
        description = firstLine ? firstLine.trim().substring(0, 150) : row.prompt.substring(0, 150);
      }
      return {
        id: row.id,
        status: (row.status === 'running' && row.pid && isProcessAlive(row.pid) ? 'alive' : row.status === 'completed' ? 'completed' : row.status === 'failed' ? 'failed' : row.status) as SessionStatus,
        priority: row.priority as SessionPriority, agentType: row.agent_type || 'unknown', title: row.title || '',
        pid: row.pid, lastAction: snapshot.tool, lastActionTimestamp: snapshot.timestamp || row.spawned_at || row.enqueued_at,
        lastMessage: snapshot.lastMessage, description, killReason: null, totalTokens: null,
        sessionId: agentId || row.id, elapsed, worklog: null, worktreePath,
        startedAt: row.spawned_at || row.enqueued_at || null,
        completedAt: row.completed_at || null,
      };
    }

    const queued = rows.filter(r => r.status === 'queued').map(toSession);
    const running = rows.filter(r => r.status === 'running' || r.status === 'spawning').filter(r => r.pid && isProcessAlive(r.pid!)).map(toSession);
    const suspended = rows.filter(r => r.status === 'suspended').map(toSession);
    const allCompleted = doneRows.map(r => { const s = toSession(r); s.worklog = findWorklog(r.id, r.metadata); return s; });

    const completedMap = new Map<string, { session: SessionItem; count: number }>();
    for (const s of allCompleted) { const existing = completedMap.get(s.title); if (!existing) completedMap.set(s.title, { session: s, count: 1 }); else existing.count++; }
    const completed = Array.from(completedMap.values()).map(({ session, count }) => { if (count > 1) session.title = `${session.title} (${count}x)`; return session; });

    return { queued, running, suspended, completed, maxConcurrent };
  } finally { closeDb(db); }
}

export function readMoreCompleted(offset: number, limit: number): SessionItem[] {
  const db = openDb(path.join(PROJECT_DIR, '.claude', 'state', 'session-queue.db'));
  if (!db) return [];
  try {
    const rows = db.prepare("SELECT * FROM queue_items WHERE status IN ('completed','failed') ORDER BY completed_at DESC LIMIT ? OFFSET ?").all(limit + 10, offset) as QueueRow[];
    const sessions = rows.map(row => {
      const agentId: string | null = row.agent_id || null;
      const worktreePath: string | null = row.worktree_path || null;
      const start = parseSqliteDatetime(row.spawned_at ?? row.enqueued_at);
      const end = parseSqliteDatetime(row.completed_at);
      const elapsed = (!isNaN(end.getTime()) && !isNaN(start.getTime())) ? formatElapsed(Math.max(0, end.getTime() - start.getTime())) : '?';
      const snapshot = agentId ? getSessionSnapshot(agentId, worktreePath) : { tool: null, timestamp: null, lastMessage: null };
      return {
        id: row.id, status: (row.status === 'completed' ? 'completed' : 'failed') as SessionStatus,
        priority: row.priority as SessionPriority, agentType: row.agent_type || 'unknown', title: row.title || '',
        pid: row.pid, lastAction: snapshot.tool, lastActionTimestamp: snapshot.timestamp || row.completed_at || row.spawned_at || row.enqueued_at,
        lastMessage: snapshot.lastMessage, description: null, killReason: null, totalTokens: null,
        sessionId: agentId || row.id, elapsed, worklog: findWorklog(row.id, row.metadata), worktreePath,
        startedAt: row.spawned_at || row.enqueued_at || null, completedAt: row.completed_at || null,
      } as SessionItem;
    });
    const seen = new Map<string, { session: SessionItem; count: number }>();
    for (const s of sessions) { const existing = seen.get(s.title); if (!existing) seen.set(s.title, { session: s, count: 1 }); else existing.count++; }
    return Array.from(seen.values()).map(({ session, count }) => { if (count > 1) session.title = `${session.title} (${count}x)`; return session; }).slice(0, limit);
  } finally { closeDb(db); }
}

function findWorklog(queueId: string, metadata: string | null): WorklogEntry | null {
  const db = openDb(path.join(PROJECT_DIR, '.claude', 'worklog.db'));
  if (!db) return null;
  try {
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
      const monitorAlive = t.monitor_pid !== null && isProcessAlive(t.monitor_pid);
      const hbMs = t.last_heartbeat ? Date.now() - parseSqliteDatetime(t.last_heartbeat).getTime() : Infinity;
      let meta: Record<string, unknown> = {};
      try { if (t.metadata) meta = JSON.parse(t.metadata); } catch { /* */ }
      let monitorAgentId: string | null = null;
      if (queueDb && t.monitor_pid) {
        try {
          const row = queueDb.prepare("SELECT agent_id FROM queue_items WHERE pid = ? AND status = 'running' LIMIT 1").get(t.monitor_pid) as { agent_id: string } | undefined;
          monitorAgentId = row?.agent_id ?? null;
        } catch { /* */ }
      }
      const monitorSession: SessionItem = {
        id: `pt-monitor-${t.id}`, status: monitorAlive ? 'alive' : 'paused', priority: 'critical',
        agentType: 'persistent-monitor', title: t.title, pid: t.monitor_pid,
        lastAction: null, lastActionTimestamp: t.last_heartbeat || t.activated_at || new Date().toISOString(),
        lastMessage: null, description: null, killReason: null, totalTokens: null,
        sessionId: monitorAgentId || `pt-monitor-${t.id}`, elapsed: ageStr(t.activated_at), worklog: null, worktreePath: null,
        startedAt: t.activated_at || null, completedAt: null,
      };
      let subTasks: SubTaskItem[] = [];
      // Build taskId→session map from queue DB for reliable matching
      // (the todo.db status may be 'completed' while the session is still running)
      const taskIdToSession = new Map<string, SessionItem>();
      if (queueDb) {
        try {
          const runningItems = queueDb.prepare(
            "SELECT id, metadata FROM queue_items WHERE status IN ('running', 'spawning') AND metadata IS NOT NULL"
          ).all() as Array<{ id: string; metadata: string }>;
          for (const item of runningItems) {
            try {
              const meta = JSON.parse(item.metadata);
              if (meta.taskId) {
                const matched = runningSessions.find(s => s.id === item.id);
                if (matched) taskIdToSession.set(meta.taskId, matched);
              }
            } catch { /* skip malformed metadata */ }
          }
        } catch { /* non-fatal */ }
      }
      if (todoDb) {
        try {
          const links = ptDb.prepare("SELECT todo_task_id FROM sub_tasks WHERE persistent_task_id = ?").all(t.id) as Array<{ todo_task_id: string }>;
          const allSubs = links.map(link => {
            let title = '', status = 'pending', section = '', resolved = false;
            try {
              const row = todoDb.prepare("SELECT title, status, section FROM tasks WHERE id = ?").get(link.todo_task_id) as { title: string; status: string; section: string } | undefined;
              if (row) { title = row.title; status = row.status; section = row.section; resolved = true; }
              else { const arch = todoDb.prepare("SELECT title, section FROM archived_tasks WHERE id = ?").get(link.todo_task_id) as { title: string; section: string } | undefined; if (arch) { title = arch.title; status = 'completed'; section = arch.section; resolved = true; } }
            } catch { /* */ }
            if (!resolved) return null;
            // Primary: match via queue metadata taskId (reliable, status-independent)
            let session: SessionItem | null = taskIdToSession.get(link.todo_task_id) ?? null;
            // Fallback: title substring match for in_progress tasks
            if (!session && status === 'in_progress') { session = runningSessions.find(s => s.title.includes(title.substring(0, 20))) ?? null; }
            return { id: link.todo_task_id, title, status, section, session, agentStage: null, agentProgressPct: null, prUrl: null, prMerged: false, worklog: status === 'completed' ? findWorklog('', `{"taskId":"${link.todo_task_id}"}`) : null };
          }).filter(Boolean) as SubTaskItem[];
          const statusOrder: Record<string, number> = { in_progress: 0, completed: 1, pending: 2, pending_review: 3 };
          allSubs.sort((a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9));
          const active = allSubs.filter((s: SubTaskItem) => s.status === 'in_progress');
          const done = allSubs.filter((s: SubTaskItem) => s.status === 'completed').slice(0, 8);
          const pendingCount = allSubs.filter((s: SubTaskItem) => s.status === 'pending' || s.status === 'pending_review').length;
          subTasks = [...active, ...done];
          if (pendingCount > 0) { subTasks.push({ id: `pending-summary-${t.id}`, title: `${pendingCount} pending task${pendingCount !== 1 ? 's' : ''}`, status: 'pending', section: '', session: null, agentStage: null, agentProgressPct: null, prUrl: null, prMerged: false, worklog: null }); }
        } catch { /* */ }
      }
      return { id: t.id, title: t.title, status: t.status, age: ageStr(t.activated_at), cycleCount: t.cycle_count ?? 0, heartbeatAge: t.last_heartbeat ? ageStr(t.last_heartbeat) : 'never', heartbeatStale: hbMs > 15 * 60 * 1000, demoInvolved: meta.demo_involved === true, strictInfraGuidance: meta.strict_infra_guidance === true, monitorSession, subTasks };
    });
  } finally { closeDb(ptDb); closeDb(todoDb); closeDb(queueDb); }
}

// ============================================================================
// Main
// ============================================================================

export function readLiveData(): LiveDashboardData {
  const { queued, running, suspended, completed, maxConcurrent } = readSessionQueue();
  const persistentTasks = readPersistentTasks(running);
  const ptPids = new Set<number>();
  const ptTitlePrefixes = new Set<string>();
  for (const pt of persistentTasks) {
    if (pt.monitorSession.pid) ptPids.add(pt.monitorSession.pid);
    ptTitlePrefixes.add(pt.title.substring(0, 30));
    for (const st of pt.subTasks) { if (st.session?.pid) ptPids.add(st.session.pid); }
  }
  const standaloneRunning = running.filter(s => {
    if (s.pid && ptPids.has(s.pid)) return false;
    if (s.title.includes('[Persistent]') || s.title.includes('Monitor revival') || s.title.includes('Stale-pause revival')) {
      for (const prefix of ptTitlePrefixes) { if (s.title.includes(prefix)) return false; }
    }
    return true;
  });
  const standaloneCompleted = completed.filter(s => {
    for (const prefix of ptTitlePrefixes) { if (s.title.includes(prefix) && (s.title.includes('Monitor revival') || s.title.includes('Stale-pause revival'))) return false; }
    return true;
  });
  return { queuedSessions: queued, persistentTasks, runningSessions: standaloneRunning, suspendedSessions: suspended, completedSessions: standaloneCompleted, capacity: { running: running.length, max: maxConcurrent } };
}

// ============================================================================
// Session Tail + Signal
// ============================================================================

export function readSessionTail(agentId: string, fromPosition?: number, worktreePath?: string | null): { entries: ActivityEntry[]; newPosition: number } {
  const file = findSessionFile(agentId, worktreePath);
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
      try { parsed = JSON.parse(trimmed) as Record<string, unknown>; } catch { continue; }
      const timestamp = (typeof parsed['timestamp'] === 'string' ? parsed['timestamp'] : new Date().toISOString());
      if (parsed['type'] === 'compact_boundary') { entries.push({ type: 'compaction', timestamp, text: '[context compacted]' }); continue; }
      if (parsed['type'] === 'assistant') {
        const msg = parsed['message'] as Record<string, unknown> | undefined;
        const content = Array.isArray(msg?.['content']) ? (msg!['content'] as unknown[]) : [];
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b['type'] === 'tool_use') {
            const toolName = typeof b['name'] === 'string' ? b['name'] : 'unknown';
            const inputObj = b['input'];
            let toolInput = '';
            if (inputObj && typeof inputObj === 'object') { const keys = Object.keys(inputObj as object); const firstKey = keys[0]; if (firstKey) { const val = (inputObj as Record<string, unknown>)[firstKey]; const valStr = typeof val === 'string' ? val : JSON.stringify(val); toolInput = `${firstKey}: ${valStr.substring(0, 60)}`; if (keys.length > 1) toolInput += ` +${keys.length - 1}`; } }
            entries.push({ type: 'tool_call', timestamp, text: toolName, toolName, toolInput });
          } else if (b['type'] === 'text') {
            const textVal = typeof b['text'] === 'string' ? b['text'] : '';
            if (textVal.trim().length > 3) entries.push({ type: 'assistant_text', timestamp, text: textVal.trim() });
          }
        }
        continue;
      }
      if (parsed['type'] === 'tool_result') {
        const content = parsed['content'];
        let preview = '';
        if (typeof content === 'string') preview = content.trim().substring(0, 150);
        else if (Array.isArray(content)) { for (const c of content as unknown[]) { const cb = c as Record<string, unknown>; if (cb['type'] === 'text' && typeof cb['text'] === 'string') { preview = cb['text'].trim().substring(0, 150); break; } } }
        if (preview) entries.push({ type: 'tool_result', timestamp, text: preview, resultPreview: preview });
        continue;
      }
      if (parsed['type'] === 'error' || (typeof parsed['error'] === 'string' && parsed['error'])) {
        const errMsg = typeof parsed['error'] === 'string' ? parsed['error'] : JSON.stringify(parsed).substring(0, 150);
        entries.push({ type: 'error', timestamp, text: errMsg });
      }
    }
    return { entries, newPosition: fileSize };
  } catch { return { entries: [], newPosition: fromPosition ?? 0 }; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* */ } }
}

export function resumeSessionWithMessage(agentOrSessionId: string, message: string): void {
  const projectDir = process.env['CLAUDE_PROJECT_DIR'] || process.cwd();
  let resumeId = agentOrSessionId;
  if (agentOrSessionId.startsWith('agent-')) {
    const sessionFile = findSessionFile(agentOrSessionId);
    if (sessionFile) resumeId = path.basename(sessionFile, '.jsonl');
  }
  try {
    const child = spawn('claude', ['--resume', resumeId, '-p', message], {
      cwd: projectDir,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    });
    child.unref();
  } catch (err) {
    try {
      fs.appendFileSync(
        path.join(projectDir, '.claude', 'state', 'dashboard-resume.log'),
        `[${new Date().toISOString()}] resumeSessionWithMessage failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    } catch { /* */ }
  }
}

export function sendDirectiveSignal(toAgentId: string, message: string, worktreePath?: string | null): { success: boolean; signalId: string } {
  const id = `sig-${crypto.randomUUID().slice(0, 8)}`;
  const filename = `${toAgentId}-${Date.now()}-${id}.json`;
  const signal = { id, from_agent_id: 'cto-dashboard', from_agent_type: 'cto', from_task_title: 'CTO Dashboard Signal', to_agent_id: toAgentId, to_agent_type: 'agent', tier: 'directive', message, created_at: new Date().toISOString(), read_at: null, acknowledged_at: null };
  const content = JSON.stringify(signal);

  // Write to main project signal dir
  const mainSignalDir = path.join(PROJECT_DIR, '.claude', 'state', 'session-signals');
  fs.mkdirSync(mainSignalDir, { recursive: true });
  const mainTmp = path.join(mainSignalDir, `.${filename}.tmp`);
  fs.writeFileSync(mainTmp, content);
  fs.renameSync(mainTmp, path.join(mainSignalDir, filename));

  // Also write to worktree signal dir if agent is in a worktree
  // (worktree .claude/state/ is a separate directory, not symlinked to main tree)
  if (worktreePath) {
    try {
      const wtSignalDir = path.join(worktreePath, '.claude', 'state', 'session-signals');
      fs.mkdirSync(wtSignalDir, { recursive: true });
      const wtTmp = path.join(wtSignalDir, `.${filename}.tmp`);
      fs.writeFileSync(wtTmp, content);
      fs.renameSync(wtTmp, path.join(wtSignalDir, filename));
    } catch { /* non-fatal — main tree copy is the fallback */ }
  }

  try { fs.appendFileSync(path.join(PROJECT_DIR, '.claude', 'state', 'session-comms.log'), content + '\n'); } catch { /* */ }
  return { success: true, signalId: id };
}

export function getSignalDeliveryStatus(signalId: string, worktreePath?: string | null): { status: 'pending' | 'read' | 'acknowledged'; read_at?: string; acknowledged_at?: string } | null {
  // Check both main tree and worktree signal dirs — return the most-advanced status
  // (agent updates the worktree copy; main tree copy stays pending)
  const dirs = [path.join(PROJECT_DIR, '.claude', 'state', 'session-signals')];
  if (worktreePath) dirs.push(path.join(worktreePath, '.claude', 'state', 'session-signals'));
  type SignalStatus = { status: 'pending' | 'read' | 'acknowledged'; read_at?: string; acknowledged_at?: string };
  let best: SignalStatus | null = null;
  const rank: Record<string, number> = { pending: 0, read: 1, acknowledged: 2 };
  for (const signalDir of dirs) {
    try {
      const files = fs.readdirSync(signalDir).filter(f => f.includes(signalId));
      for (const file of files) {
        const signal = JSON.parse(fs.readFileSync(path.join(signalDir, file), 'utf8'));
        let current: SignalStatus;
        if (signal.acknowledged_at) current = { status: 'acknowledged', read_at: signal.read_at, acknowledged_at: signal.acknowledged_at };
        else if (signal.read_at) current = { status: 'read', read_at: signal.read_at };
        else current = { status: 'pending' };
        if (!best || (rank[current.status] ?? 0) > (rank[best.status] ?? 0)) best = current;
      }
    } catch { /* */ }
  }
  return best;
}

export function getSessionSummaries(agentId: string): Array<{ id: string; summary: string; created_at: string }> {
  const dbPath = path.join(PROJECT_DIR, '.claude', 'state', 'session-activity.db');
  if (!fs.existsSync(dbPath)) return [];
  let db: InstanceType<typeof Database> | null = null;
  try { db = new Database(dbPath, { readonly: true }); return db.prepare('SELECT id, summary, created_at FROM session_summaries WHERE agent_id = ? ORDER BY created_at ASC').all(agentId) as Array<{ id: string; summary: string; created_at: string }>; }
  catch { return []; }
  finally { try { db?.close(); } catch { /* */ } }
}

// ============================================================================
// Page 2: Demo Scenarios + Test Files
// ============================================================================

interface ScenarioRow {
  id: string; persona_id: string; title: string; description: string;
  category: string | null; playwright_project: string; test_file: string;
  sort_order: number; enabled: number; headed: number;
  last_recorded_at: string | null; recording_path: string | null; persona_name: string;
}

export function readDemoScenarios(): DemoScenarioItem[] {
  const db = openDb(path.join(PROJECT_DIR, '.claude', 'user-feedback.db'));
  if (!db) return [];
  try {
    const rows = db.prepare(`
      SELECT ds.id, ds.persona_id, ds.title, ds.description, ds.category,
             ds.playwright_project, ds.test_file, ds.sort_order, ds.enabled,
             ds.headed, ds.last_recorded_at, ds.recording_path,
             p.name AS persona_name
      FROM demo_scenarios ds
      JOIN personas p ON p.id = ds.persona_id
      ORDER BY ds.sort_order ASC, ds.title ASC
    `).all() as ScenarioRow[];
    return rows.map(r => ({
      id: r.id,
      personaId: r.persona_id,
      personaName: r.persona_name,
      title: r.title,
      description: r.description,
      category: r.category,
      playwrightProject: r.playwright_project,
      testFile: r.test_file,
      sortOrder: r.sort_order,
      enabled: r.enabled === 1,
      headed: r.headed === 1,
      lastRecordedAt: r.last_recorded_at,
      recordingPath: r.recording_path && fs.existsSync(r.recording_path) ? r.recording_path : null,
    }));
  } catch { return []; }
  finally { closeDb(db); }
}

const INFRA_PROJECTS = new Set(['seed', 'auth-setup', 'cleanup', 'setup']);

export function discoverTestFiles(): TestFileItem[] {
  const configFile = ['playwright.config.ts', 'playwright.config.js']
    .map(f => path.join(PROJECT_DIR, f))
    .find(f => fs.existsSync(f));
  if (!configFile) return [];

  let configText: string;
  try { configText = fs.readFileSync(configFile, 'utf8'); } catch { return []; }

  // Extract projects array
  const projectsMatch = configText.match(/projects\s*:\s*\[/);
  if (!projectsMatch) return [];

  const startIdx = projectsMatch.index! + projectsMatch[0].length;
  let depth = 1;
  let endIdx = startIdx;
  for (let i = startIdx; i < configText.length && depth > 0; i++) {
    if (configText[i] === '[') depth++;
    else if (configText[i] === ']') depth--;
    endIdx = i;
  }
  const projectsBlock = configText.substring(startIdx, endIdx);

  // Extract individual project blocks
  const results: TestFileItem[] = [];
  const projectBlockRegex = /\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g;
  let match: RegExpExecArray | null;
  while ((match = projectBlockRegex.exec(projectsBlock)) !== null) {
    const block = match[0];
    const nameMatch = block.match(/name\s*:\s*['"]([^'"]+)['"]/);
    const testDirMatch = block.match(/testDir\s*:\s*['"]([^'"]+)['"]/);
    if (!nameMatch) continue;
    const projectName = nameMatch[1];
    if (INFRA_PROJECTS.has(projectName)) continue;
    if (projectName.endsWith('-manual')) continue;

    const testDir = testDirMatch ? testDirMatch[1] : 'e2e';
    const fullDir = path.join(PROJECT_DIR, testDir);
    if (!fs.existsSync(fullDir)) continue;

    try {
      const scanDir = (dir: string, prefix: string) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile() && (entry.name.endsWith('.spec.ts') || entry.name.endsWith('.demo.ts'))) {
            const filePath = prefix ? `${prefix}/${entry.name}` : entry.name;
            results.push({
              project: projectName,
              filePath: `${testDir}/${filePath}`,
              fileName: entry.name,
              isDemo: entry.name.endsWith('.demo.ts'),
              runner: 'playwright',
            });
          } else if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
            scanDir(path.join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
          }
        }
      };
      scanDir(fullDir, '');
    } catch { /* */ }
  }

  results.sort((a, b) => a.project.localeCompare(b.project) || a.fileName.localeCompare(b.fileName));
  return results;
}

export function readProcessOutput(filePath: string, fromByte: number): { text: string; newPosition: number } {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;
    if (fileSize <= fromByte) return { text: '', newPosition: fileSize };
    const bytesToRead = fileSize - fromByte;
    const buf = Buffer.alloc(bytesToRead);
    fs.readSync(fd, buf, 0, bytesToRead, fromByte);
    return { text: buf.toString('utf8'), newPosition: fileSize };
  } catch { return { text: '', newPosition: fromByte }; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* */ } }
}

const TEST_FILE_PATTERNS = ['.test.ts', '.test.tsx', '.test.js', '.test.jsx'];
const UNIT_SKIP_DIRS = new Set(['node_modules', '.next', '.turbo', 'dist', '.claude', '.git', 'coverage', '.cache']);

function discoverUnitTests(): TestFileItem[] {
  const results: TestFileItem[] = [];
  // Find vitest/jest configs
  const configs: Array<{ configPath: string; runner: 'vitest' | 'jest'; dir: string; group: string }> = [];

  const scanForConfigs = (dir: string, depth: number) => {
    if (depth > 4) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (UNIT_SKIP_DIRS.has(entry.name)) continue;
          scanForConfigs(path.join(dir, entry.name), depth + 1);
        } else if (entry.isFile()) {
          const full = path.join(dir, entry.name);
          if (entry.name.startsWith('vitest.config.')) {
            configs.push({ configPath: full, runner: 'vitest', dir, group: path.relative(PROJECT_DIR, dir) || '.' });
          } else if (entry.name.startsWith('jest.config.')) {
            configs.push({ configPath: full, runner: 'jest', dir, group: path.relative(PROJECT_DIR, dir) || '.' });
          }
        }
      }
    } catch { /* */ }
  };
  scanForConfigs(PROJECT_DIR, 0);

  // Also check for package.json test scripts that imply vitest/jest at root
  if (configs.length === 0) {
    try {
      const pkgRaw = fs.readFileSync(path.join(PROJECT_DIR, 'package.json'), 'utf8');
      const pkg = JSON.parse(pkgRaw);
      const testScript = pkg?.scripts?.test ?? '';
      if (testScript.includes('vitest')) configs.push({ configPath: '', runner: 'vitest', dir: PROJECT_DIR, group: '.' });
      else if (testScript.includes('jest')) configs.push({ configPath: '', runner: 'jest', dir: PROJECT_DIR, group: '.' });
    } catch { /* */ }
  }

  // For each config, find test files in its directory
  for (const cfg of configs) {
    const scanTests = (dir: string) => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            if (UNIT_SKIP_DIRS.has(entry.name)) continue;
            scanTests(path.join(dir, entry.name));
          } else if (entry.isFile() && TEST_FILE_PATTERNS.some(p => entry.name.endsWith(p))) {
            const filePath = path.relative(PROJECT_DIR, path.join(dir, entry.name));
            results.push({
              project: cfg.group,
              filePath,
              fileName: entry.name,
              isDemo: false,
              runner: cfg.runner,
            });
          }
        }
      } catch { /* */ }
    };
    scanTests(cfg.dir);
  }

  // Also discover hook tests (.claude/hooks/__tests__)
  const hookTestDir = path.join(PROJECT_DIR, '.claude', 'hooks', '__tests__');
  if (fs.existsSync(hookTestDir)) {
    try {
      const entries = fs.readdirSync(hookTestDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && TEST_FILE_PATTERNS.some(p => entry.name.endsWith(p))) {
          results.push({
            project: 'hooks',
            filePath: `.claude/hooks/__tests__/${entry.name}`,
            fileName: entry.name,
            isDemo: false,
            runner: 'vitest',
          });
        }
      }
    } catch { /* */ }
  }

  results.sort((a, b) => a.project.localeCompare(b.project) || a.fileName.localeCompare(b.fileName));
  return results;
}

export function readPage2Data(): Page2Data {
  return {
    scenarios: readDemoScenarios(),
    testFiles: [...discoverTestFiles(), ...discoverUnitTests()],
  };
}

// ============================================================================
// Page 3: Plans
// ============================================================================

function getTaskProgressPct(db: Database.Database, taskId: string): number {
  try {
    const total = (db.prepare('SELECT COUNT(*) as c FROM substeps WHERE task_id = ?').get(taskId) as { c: number }).c;
    if (total === 0) {
      const task = db.prepare('SELECT status FROM plan_tasks WHERE id = ?').get(taskId) as { status: string } | undefined;
      return task?.status === 'completed' ? 100 : 0;
    }
    const completed = (db.prepare('SELECT COUNT(*) as c FROM substeps WHERE task_id = ? AND completed = 1').get(taskId) as { c: number }).c;
    return Math.round((completed / total) * 100);
  } catch { return 0; }
}

function getPhaseProgressPct(db: Database.Database, phaseId: string): number {
  try {
    const tasks = db.prepare('SELECT id FROM plan_tasks WHERE phase_id = ?').all(phaseId) as Array<{ id: string }>;
    if (tasks.length === 0) return 0;
    const progresses = tasks.map(t => getTaskProgressPct(db, t.id));
    return Math.round(progresses.reduce((a, b) => a + b, 0) / progresses.length);
  } catch { return 0; }
}

function getPlanProgressPct(db: Database.Database, planId: string): number {
  try {
    const phases = db.prepare("SELECT id FROM phases WHERE plan_id = ? AND status != 'skipped'").all(planId) as Array<{ id: string }>;
    if (phases.length === 0) return 0;
    const progresses = phases.map(p => getPhaseProgressPct(db, p.id));
    return Math.round(progresses.reduce((a, b) => a + b, 0) / progresses.length);
  } catch { return 0; }
}

export function readPage3Data(selectedPlanId?: string | null): Page3Data {
  const dbPath = path.join(PROJECT_DIR, '.claude', 'state', 'plans.db');
  const db = openDb(dbPath);
  if (!db) return { plans: [], planDetail: null, recentChanges: [] };
  try {
    // Plan list
    const planRows = db.prepare(
      "SELECT id, title, status, updated_at, manager_pid FROM plans WHERE status IN ('draft','active','paused') ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, updated_at DESC"
    ).all() as Array<{ id: string; title: string; status: string; updated_at: string | null; manager_pid: number | null }>;

    const plans: PlanItem[] = planRows.map(p => {
      const phaseCount = (db!.prepare('SELECT COUNT(*) as c FROM phases WHERE plan_id = ?').get(p.id) as { c: number }).c;
      const taskCount = (db!.prepare('SELECT COUNT(*) as c FROM plan_tasks WHERE plan_id = ?').get(p.id) as { c: number }).c;
      const completedTasks = (db!.prepare("SELECT COUNT(*) as c FROM plan_tasks WHERE plan_id = ? AND status = 'completed'").get(p.id) as { c: number }).c;
      const readyTasks = (db!.prepare("SELECT COUNT(*) as c FROM plan_tasks WHERE plan_id = ? AND status = 'ready'").get(p.id) as { c: number }).c;
      const activeTasks = (db!.prepare("SELECT COUNT(*) as c FROM plan_tasks WHERE plan_id = ? AND status = 'in_progress'").get(p.id) as { c: number }).c;
      const currentPhaseRow = db!.prepare("SELECT title FROM phases WHERE plan_id = ? AND status NOT IN ('completed','skipped') ORDER BY phase_order LIMIT 1").get(p.id) as { title: string } | undefined;
      const managerAlive = p.manager_pid !== null && isProcessAlive(p.manager_pid);
      return {
        id: p.id, title: p.title, status: p.status,
        progressPct: getPlanProgressPct(db!, p.id),
        phaseCount, taskCount, completedTasks, readyTasks, activeTasks,
        currentPhase: currentPhaseRow?.title ?? null,
        updatedAt: p.updated_at,
        managerPid: p.manager_pid,
        managerAlive,
      };
    });

    // Plan detail (phases → tasks → substeps)
    let planDetail: Page3Data['planDetail'] = null;
    if (selectedPlanId) {
      const phaseRows = db.prepare(
        'SELECT id, title, phase_order, status FROM phases WHERE plan_id = ? ORDER BY phase_order'
      ).all(selectedPlanId) as Array<{ id: string; title: string; phase_order: number; status: string }>;

      const phases: PlanPhaseItem[] = phaseRows.map(ph => {
        const taskRows = db!.prepare(
          'SELECT id, title, status, agent_type, category_id, pr_number, pr_merged, persistent_task_id FROM plan_tasks WHERE phase_id = ? ORDER BY task_order'
        ).all(ph.id) as Array<{
          id: string; title: string; status: string; agent_type: string | null; category_id: string | null;
          pr_number: number | null; pr_merged: number; persistent_task_id: string | null;
        }>;

        const tasks: PlanTaskItem[] = taskRows.map(t => {
          const substepRows = db!.prepare(
            'SELECT id, title, completed FROM substeps WHERE task_id = ? ORDER BY step_order'
          ).all(t.id) as Array<{ id: string; title: string; completed: number }>;

          const substeps: PlanSubstepItem[] = substepRows.map(s => ({
            id: s.id, title: s.title, completed: s.completed === 1,
          }));

          // Find blocking task titles
          const depRows = db!.prepare(
            "SELECT pt.title FROM dependencies d JOIN plan_tasks pt ON pt.id = d.blocker_id WHERE d.blocked_id = ? AND d.blocker_type = 'task' AND pt.status NOT IN ('completed','skipped')"
          ).all(t.id) as Array<{ title: string }>;
          const blockedBy = depRows.map(r => r.title);

          const completedSubsteps = substeps.filter(s => s.completed).length;
          return {
            id: t.id, title: t.title, status: t.status,
            agentType: t.agent_type, categoryId: t.category_id,
            prNumber: t.pr_number, prMerged: t.pr_merged === 1,
            persistentTaskId: t.persistent_task_id,
            substeps,
            substepProgress: substeps.length > 0 ? `${completedSubsteps}/${substeps.length}` : '',
            progressPct: getTaskProgressPct(db!, t.id),
            blockedBy,
          };
        });

        return {
          id: ph.id, title: ph.title, phaseOrder: ph.phase_order,
          status: ph.status, progressPct: getPhaseProgressPct(db!, ph.id),
          tasks,
        };
      });

      planDetail = { planId: selectedPlanId, phases };
    }

    // Recent state changes (last 10)
    const changeRows = db.prepare(
      `SELECT sc.entity_type, sc.entity_id, sc.field_name, sc.old_value, sc.new_value, sc.changed_at
       FROM state_changes sc
       ORDER BY sc.changed_at DESC LIMIT 10`
    ).all() as Array<{
      entity_type: string; entity_id: string; field_name: string;
      old_value: string | null; new_value: string | null; changed_at: string;
    }>;

    const recentChanges: PlanStateChange[] = changeRows.map(c => {
      let label = '';
      try {
        if (c.entity_type === 'task') {
          const row = db!.prepare('SELECT title FROM plan_tasks WHERE id = ?').get(c.entity_id) as { title: string } | undefined;
          label = row?.title ?? c.entity_id;
        } else if (c.entity_type === 'phase') {
          const row = db!.prepare('SELECT title FROM phases WHERE id = ?').get(c.entity_id) as { title: string } | undefined;
          label = row?.title ?? c.entity_id;
        } else if (c.entity_type === 'plan') {
          const row = db!.prepare('SELECT title FROM plans WHERE id = ?').get(c.entity_id) as { title: string } | undefined;
          label = row?.title ?? c.entity_id;
        } else if (c.entity_type === 'substep') {
          const row = db!.prepare('SELECT title FROM substeps WHERE id = ?').get(c.entity_id) as { title: string } | undefined;
          label = row?.title ?? c.entity_id;
        }
      } catch { label = c.entity_id; }
      return { label, field: c.field_name, oldValue: c.old_value, newValue: c.new_value, changedAt: c.changed_at };
    });

    return { plans, planDetail, recentChanges };
  } catch { return { plans: [], planDetail: null, recentChanges: [] }; }
  finally { closeDb(db); }
}

// ============================================================================
// Page 4: Specs
// ============================================================================

function resolveFrameworkDir(): string | null {
  if (fs.existsSync(path.join(PROJECT_DIR, 'node_modules', 'gentyr'))) {
    return path.join(PROJECT_DIR, 'node_modules', 'gentyr');
  }
  if (fs.existsSync(path.join(PROJECT_DIR, '.claude-framework'))) {
    return path.join(PROJECT_DIR, '.claude-framework');
  }
  return null;
}

function parseSpecMetadata(filePath: string): { title: string; ruleId: string | null; severity: string | null } {
  let title = path.basename(filePath, '.md');
  let ruleId: string | null = null;
  let severity: string | null = null;
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4096);
    const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
    const text = buf.slice(0, bytesRead).toString('utf8');
    const lines = text.split('\n').slice(0, 20);
    for (const line of lines) {
      if (!title || title === path.basename(filePath, '.md')) {
        const headingMatch = line.match(/^#\s+(.+)/);
        if (headingMatch) title = headingMatch[1].trim();
      }
      const ruleMatch = line.match(/\*\*Rule ID\*\*:\s*(.+)/);
      if (ruleMatch) ruleId = ruleMatch[1].trim();
      const sevMatch = line.match(/\*\*Severity\*\*:\s*(.+)/);
      if (sevMatch) severity = sevMatch[1].trim().toLowerCase();
    }
  } catch { /* */ } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* */ }
  }
  return { title, ruleId, severity };
}

function readSpecsFromDir(dirPath: string, categoryKey: string, source: 'framework' | 'project'): SpecItem[] {
  if (!fs.existsSync(dirPath)) return [];
  try {
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.md'));
    return files.map(f => {
      const filePath = path.join(dirPath, f);
      const specId = f.replace(/\.md$/, '');
      const { title, ruleId, severity } = parseSpecMetadata(filePath);
      return { specId, title, ruleId, severity, category: categoryKey, filePath };
    });
  } catch { return []; }
}

export function readPage4Data(selectedSpecId?: string | null): Page4Data {
  const fwDir = resolveFrameworkDir();
  const categories: SpecCategoryItem[] = [];

  // Framework categories
  if (fwDir) {
    const fwSpecs = path.join(fwDir, 'specs', 'framework');
    if (fs.existsSync(fwSpecs)) {
      categories.push({ key: 'framework', description: 'Core framework invariants', source: 'framework', specs: readSpecsFromDir(fwSpecs, 'framework', 'framework') });
    }
    const patternSpecs = path.join(fwDir, 'specs', 'patterns');
    if (fs.existsSync(patternSpecs)) {
      categories.push({ key: 'patterns', description: 'Framework patterns and conventions', source: 'framework', specs: readSpecsFromDir(patternSpecs, 'patterns', 'framework') });
    }
  }

  // Project default categories
  const specsDirs: Array<{ dir: string; key: string; description: string }> = [
    { dir: path.join(PROJECT_DIR, 'specs', 'local'), key: 'local', description: 'Project-specific component specs' },
    { dir: path.join(PROJECT_DIR, 'specs', 'global'), key: 'global', description: 'Global project invariants' },
    { dir: path.join(PROJECT_DIR, 'specs', 'reference'), key: 'reference', description: 'Reference documentation specs' },
    { dir: path.join(PROJECT_DIR, '.claude', 'specs', 'local'), key: 'local', description: 'Project-specific component specs' },
    { dir: path.join(PROJECT_DIR, '.claude', 'specs', 'global'), key: 'global', description: 'Global project invariants' },
    { dir: path.join(PROJECT_DIR, '.claude', 'specs', 'reference'), key: 'reference', description: 'Reference documentation specs' },
  ];
  for (const { dir, key, description } of specsDirs) {
    if (!fs.existsSync(dir)) continue;
    const existing = categories.find(c => c.key === key);
    const newSpecs = readSpecsFromDir(dir, key, 'project');
    if (existing) {
      existing.specs.push(...newSpecs);
    } else if (newSpecs.length > 0) {
      categories.push({ key, description, source: 'project', specs: newSpecs });
    }
  }

  // Custom categories from .claude/specs-config.json
  const configPath = path.join(PROJECT_DIR, '.claude', 'specs-config.json');
  if (fs.existsSync(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { categories?: Array<{ key: string; description?: string; dir: string }> };
      for (const cat of cfg.categories ?? []) {
        if (!cat.key || !cat.dir) continue;
        const specs = readSpecsFromDir(path.resolve(PROJECT_DIR, cat.dir), cat.key, 'project');
        categories.push({ key: cat.key, description: cat.description ?? cat.key, source: 'project', specs });
      }
    } catch { /* */ }
  }

  // Suites from .claude/hooks/suites-config.json
  const suitesPath = path.join(PROJECT_DIR, '.claude', 'hooks', 'suites-config.json');
  const suites: SuiteItem[] = [];
  if (fs.existsSync(suitesPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(suitesPath, 'utf8')) as { suites?: Array<{ id: string; description?: string; scope?: string; enabled?: boolean }> };
      for (const s of raw.suites ?? []) {
        suites.push({ id: s.id, description: s.description ?? s.id, scope: s.scope ?? '', enabled: s.enabled !== false });
      }
    } catch { /* */ }
  }

  // Selected spec content
  let selectedSpecContent: string | null = null;
  if (selectedSpecId) {
    for (const cat of categories) {
      const spec = cat.specs.find(s => s.specId === selectedSpecId);
      if (spec) {
        try { selectedSpecContent = fs.readFileSync(spec.filePath, 'utf8'); } catch { /* */ }
        break;
      }
    }
  }

  const totalSpecs = categories.reduce((sum, c) => sum + c.specs.length, 0);
  return { categories, suites, totalSpecs, selectedSpecContent };
}
