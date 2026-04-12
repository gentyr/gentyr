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
            let session: SessionItem | null = null;
            if (status === 'in_progress') { session = runningSessions.find(s => s.title.includes(title.substring(0, 20))) ?? null; }
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
  } finally { closeDb(ptDb); closeDb(todoDb); }
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
            const preview = textVal.trim().split('\n').find((l: string) => l.trim().length > 3) ?? '';
            if (preview.length > 5) entries.push({ type: 'assistant_text', timestamp, text: preview.substring(0, 200) });
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
  last_recorded_at: string | null; persona_name: string;
}

export function readDemoScenarios(): DemoScenarioItem[] {
  const db = openDb(path.join(PROJECT_DIR, '.claude', 'user-feedback.db'));
  if (!db) return [];
  try {
    const rows = db.prepare(`
      SELECT ds.id, ds.persona_id, ds.title, ds.description, ds.category,
             ds.playwright_project, ds.test_file, ds.sort_order, ds.enabled,
             ds.headed, ds.last_recorded_at,
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

export function readPage2Data(): Page2Data {
  return {
    scenarios: readDemoScenarios(),
    testFiles: discoverTestFiles(),
  };
}
