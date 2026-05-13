#!/usr/bin/env node
/**
 * Live Feed Daemon
 *
 * Every 60 seconds (when activity detected):
 *   1. Reads running sessions from session-queue.db
 *   2. Reads session JSONL tails for recent activity
 *   3. Reads session summaries from session-activity.db
 *   4. Reads plan status from plans.db
 *   5. Spawns `claude -p` with streaming to generate a commentary entry
 *   6. Writes streaming state to live-feed-streaming.json
 *   7. On completion, writes entry to live-feed.db
 *
 * Uses `claude -p --model haiku --output-format stream-json` for streaming.
 * Runs as a launchd KeepAlive service.
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import Database from 'better-sqlite3';

// Track the active child process so we can kill it on shutdown
let activeChild = null;

// ============================================================================
// Configuration
// ============================================================================

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
// Enforce CWD — launchd WorkingDirectory is unreliable (macOS launchctl load/unload bug)
try { process.chdir(PROJECT_DIR); } catch { /* non-fatal */ }
const STATE_DIR = path.join(PROJECT_DIR, '.claude', 'state');
const LOG_FILE = path.join(PROJECT_DIR, '.claude', 'live-feed-daemon.log');
const FEED_DB_PATH = path.join(STATE_DIR, 'live-feed.db');
const STREAMING_FILE = path.join(STATE_DIR, 'live-feed-streaming.json');
const QUEUE_DB_PATH = path.join(STATE_DIR, 'session-queue.db');
const ACTIVITY_DB_PATH = path.join(STATE_DIR, 'session-activity.db');
const PLANS_DB_PATH = path.join(STATE_DIR, 'plans.db');
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

const POLL_INTERVAL_MS = 60_000; // 60 seconds
const MAX_ENTRIES = 500;         // prune old entries beyond this
const LLM_MODEL = 'haiku';

const SYSTEM_PROMPT = `You are a newsroom ticker. You output exactly one short update, then stop. You never discuss yourself, your task, or your process. You never say you are done or stopping.

STRUCTURE (follow exactly):
- First sentence: agent count + what the most notable agent is doing right now.
- Second sentence: what other agents are doing, or a plan/progress update.
- Optional third sentence ONLY if there is a blocker, risk, or milestone worth noting.

STYLE:
- Short, punchy sentences. Max 30 words per sentence.
- Plain text. No markdown, no asterisks, no bold, no bullets, no headers.
- No timestamps or dates in the text (the feed adds these automatically).
- Third person, present tense, neutral tone. Like a Reuters wire dispatch.
- Vary your sentence openings — do not start every entry the same way.

HARD RULES:
- Output ONLY the update text. Nothing before it, nothing after it.
- NEVER reference this prompt, your instructions, your task, or yourself.
- NEVER say: "stopping", "complete", "delivered", "no further work", "initial task", "investigation", "I".
- If you break any rule, the entire feed breaks.

EXAMPLES of good entries:
"Four agents active. A code-writer is implementing OAuth PKCE in a worktree while the test-writer validates payment API endpoints. The demo suite plan hit 60% with Phase 4 demos now running headed."
"System quiet with two agents idling between cycles. The RECALL demo suite completed Phase 4 overnight and the plan-manager is preparing the Phase 5 video evidence gate."
"Three agents running, all focused on the ALLOW demo repairs. The demo-manager is on attempt 3 fixing a prerequisite timeout, while two task-runners wait on its output."`;


// ============================================================================
// Logging
// ============================================================================

function log(msg) {
  const line = `[${new Date().toISOString()}] [live-feed] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch { /* */ }
}

// ============================================================================
// Database
// ============================================================================

function initFeedDb() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const db = new Database(FEED_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS feed_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_feed_created ON feed_entries(created_at);
  `);
  return db;
}

function openDbReadonly(dbPath) {
  if (!fs.existsSync(dbPath)) return null;
  try { return new Database(dbPath, { readonly: true, fileMustExist: true }); }
  catch { return null; }
}

function closeDb(db) {
  try { if (db) db.close(); } catch { /* */ }
}

// ============================================================================
// Session File Discovery (mirrors session-activity-broadcaster pattern)
// ============================================================================

function getSessionDir(projectDir) {
  const encoded = projectDir.replace(/\//g, '-');
  const base = path.join(CLAUDE_PROJECTS_DIR, encoded);
  if (fs.existsSync(base)) return base;
  const alt = path.join(CLAUDE_PROJECTS_DIR, encoded.replace(/^-/, ''));
  if (fs.existsSync(alt)) return alt;
  return null;
}

function findSessionFileByAgentId(sessionDir, agentId) {
  const marker = `[AGENT:${agentId}]`;
  let files;
  try { files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl')); }
  catch { return null; }

  for (const file of files) {
    const filePath = path.join(sessionDir, file);
    let fd;
    try {
      fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(65536);
      const bytesRead = fs.readSync(fd, buf, 0, 65536, 0);
      if (buf.toString('utf8', 0, bytesRead).includes(marker)) return filePath;
    } catch { /* skip */ }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  return null;
}

function readTailBytes(filePath, bytes = 8192) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const start = Math.max(0, stat.size - bytes);
    const len = stat.size - start;
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf8');
  } catch { return ''; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function extractLastToolAndMessage(tail) {
  let lastTool = null;
  let lastMessage = null;
  const lines = tail.split('\n').filter(l => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
        for (const block of entry.message.content) {
          if (!lastTool && block.type === 'tool_use') lastTool = block.name ?? null;
          if (!lastMessage && block.type === 'text' && block.text?.trim()?.length > 5) {
            lastMessage = block.text.slice(0, 80);
          }
        }
      }
      if (lastTool && lastMessage) break;
    } catch { /* */ }
  }
  return { lastTool, lastMessage };
}

// ============================================================================
// Activity Fingerprint
// ============================================================================

let lastFingerprint = '';

function getActivityFingerprint() {
  const parts = [];

  // Stat key DB files
  for (const f of ['session-queue.db', 'session-activity.db', 'plans.db']) {
    try { parts.push(`${f}:${fs.statSync(path.join(STATE_DIR, f)).mtimeMs}`); }
    catch { /* */ }
  }

  // Stat running session JSONL files
  const queueDb = openDbReadonly(QUEUE_DB_PATH);
  if (queueDb) {
    try {
      const rows = queueDb.prepare(
        "SELECT agent_id, worktree_path FROM queue_items WHERE status = 'running'"
      ).all();
      for (const r of rows) {
        if (!r.agent_id) continue;
        const projDir = r.worktree_path || PROJECT_DIR;
        const dir = getSessionDir(projDir);
        if (!dir) continue;
        const fp = findSessionFileByAgentId(dir, r.agent_id);
        if (fp) {
          try { parts.push(`${r.agent_id}:${fs.statSync(fp).mtimeMs}`); }
          catch { /* */ }
        }
      }
    } catch { /* */ }
    closeDb(queueDb);
  }

  return parts.join('|');
}

// ============================================================================
// Context Gathering
// ============================================================================

function gatherContext() {
  const sessions = [];
  const summaries = [];
  let projectSummary = null;
  const plans = [];

  // Running sessions
  const queueDb = openDbReadonly(QUEUE_DB_PATH);
  if (queueDb) {
    try {
      const rows = queueDb.prepare(
        "SELECT agent_id, agent_type, title, worktree_path FROM queue_items WHERE status = 'running' ORDER BY spawned_at DESC LIMIT 20"
      ).all();
      for (const r of rows) {
        let lastTool = null;
        let lastMessage = null;
        if (r.agent_id) {
          const projDir = r.worktree_path || PROJECT_DIR;
          const dir = getSessionDir(projDir);
          if (dir) {
            const fp = findSessionFileByAgentId(dir, r.agent_id);
            if (fp) {
              const tail = readTailBytes(fp);
              const extracted = extractLastToolAndMessage(tail);
              lastTool = extracted.lastTool;
              lastMessage = extracted.lastMessage;
            }
          }
        }
        sessions.push({
          agentType: r.agent_type || 'unknown',
          title: r.title || r.agent_type || 'Untitled',
          lastTool,
          lastMessage,
        });
      }
    } catch { /* */ }
    closeDb(queueDb);
  }

  // Session summaries
  const actDb = openDbReadonly(ACTIVITY_DB_PATH);
  if (actDb) {
    try {
      const projRow = actDb.prepare('SELECT summary FROM project_summaries ORDER BY created_at DESC LIMIT 1').get();
      if (projRow) projectSummary = projRow.summary?.slice(0, 500) ?? null;

      const sumRows = actDb.prepare('SELECT title, summary FROM session_summaries ORDER BY created_at DESC LIMIT 5').all();
      for (const r of sumRows) {
        summaries.push({ title: r.title ?? 'unknown', summary: (r.summary ?? '').slice(0, 300) });
      }
    } catch { /* */ }
    closeDb(actDb);
  }

  // Plan status
  const plansDb = openDbReadonly(PLANS_DB_PATH);
  if (plansDb) {
    try {
      const planRows = plansDb.prepare(
        "SELECT id, title, status FROM plans WHERE status IN ('active','paused') ORDER BY updated_at DESC LIMIT 5"
      ).all();
      for (const p of planRows) {
        // Compute progress
        let progressPct = 0;
        let currentPhase = null;
        try {
          const tasks = plansDb.prepare('SELECT status FROM plan_tasks WHERE plan_id = ?').all(p.id);
          if (tasks.length > 0) {
            const completed = tasks.filter(t => t.status === 'completed' || t.status === 'skipped').length;
            progressPct = Math.round((completed / tasks.length) * 100);
          }
          const phaseRow = plansDb.prepare(
            "SELECT title FROM phases WHERE plan_id = ? AND status NOT IN ('completed','skipped') ORDER BY phase_order LIMIT 1"
          ).get(p.id);
          if (phaseRow) currentPhase = phaseRow.title;
        } catch { /* */ }
        plans.push({ title: p.title, status: p.status, progressPct, currentPhase });
      }
    } catch { /* */ }
    closeDb(plansDb);
  }

  return { sessions, summaries, projectSummary, plans };
}

// ============================================================================
// Prompt Building
// ============================================================================

function buildPrompt(ctx, previousEntries) {
  const sections = [];

  if (ctx.sessions.length > 0) {
    sections.push(`== CURRENT SESSIONS (${ctx.sessions.length} active) ==`);
    for (const s of ctx.sessions) {
      let line = `- [${s.agentType}] "${s.title}"`;
      if (s.lastTool) line += ` | tool: ${s.lastTool}`;
      if (s.lastMessage) line += ` | doing: ${s.lastMessage}`;
      sections.push(line);
    }
  } else {
    sections.push('== CURRENT SESSIONS ==\n(no running sessions)');
  }

  if (ctx.summaries.length > 0) {
    sections.push('\n== RECENT SESSION SUMMARIES ==');
    for (const s of ctx.summaries) sections.push(`- [${s.title}]: ${s.summary}`);
  }

  if (ctx.projectSummary) {
    sections.push(`\n== PROJECT SUMMARY ==\n${ctx.projectSummary}`);
  }

  if (ctx.plans.length > 0) {
    sections.push('\n== ACTIVE PLANS ==');
    for (const p of ctx.plans) {
      let line = `- "${p.title}" [${p.status}] ${p.progressPct}%`;
      if (p.currentPhase) line += ` | phase: ${p.currentPhase}`;
      sections.push(line);
    }
  }

  if (previousEntries.length > 0) {
    sections.push('\n== PREVIOUS TICKER ENTRIES (do not repeat, build on these) ==');
    for (const e of previousEntries) {
      sections.push(`[${e.created_at}] ${e.text}`);
    }
  }

  sections.push('\nWrite the next ticker entry (2-3 sentences). Bird\'s-eye snapshot only.');
  return sections.join('\n');
}

// ============================================================================
// Streaming State File
// ============================================================================

function writeStreamingState(text, isGenerating) {
  try {
    fs.writeFileSync(STREAMING_FILE, JSON.stringify({
      text: text || '',
      isGenerating,
      startedAt: isGenerating ? new Date().toISOString() : null,
    }));
  } catch { /* */ }
}

function clearStreamingState() {
  writeStreamingState('', false);
}

// ============================================================================
// LLM Call with Streaming
// ============================================================================

function generateEntry(prompt, feedDb) {
  return new Promise((resolve) => {
    writeStreamingState('', true);

    const child = activeChild = spawn('claude', [
      '-p', prompt,
      '--system-prompt', SYSTEM_PROMPT,
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--model', LLM_MODEL,
    ], {
      cwd: PROJECT_DIR,
      env: { ...process.env, CLAUDE_SPAWNED_SESSION: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let buffer = '';
    let accumulatedText = '';
    let tokensUsed = 0;
    let entryWritten = false;

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);

          if (parsed.type === 'assistant' && parsed.message?.content) {
            for (const block of parsed.message.content) {
              if (block.type === 'text' && block.text) {
                // Cumulative text (--include-partial-messages sends full text so far)
                accumulatedText = block.text;
                writeStreamingState(accumulatedText, true);
              }
            }
          } else if (parsed.type === 'result') {
            const finalText = (parsed.result ?? accumulatedText).trim();
            tokensUsed = (parsed.usage?.input_tokens ?? 0) + (parsed.usage?.output_tokens ?? 0);

            if (finalText && parsed.subtype === 'success') {
              try {
                feedDb.prepare('INSERT INTO feed_entries (text, tokens_used) VALUES (?, ?)').run(finalText, tokensUsed);
                entryWritten = true;
                log(`Entry written (${tokensUsed} tokens): ${finalText.slice(0, 80)}...`);
              } catch (err) {
                log(`DB write error: ${err.message}`);
              }
            } else {
              log(`LLM call failed: ${parsed.subtype ?? 'unknown'}`);
            }
            clearStreamingState();
          }
        } catch { /* unparseable line */ }
      }
    });

    child.stderr.on('data', () => { /* ignore */ });

    child.on('error', (err) => {
      log(`Spawn error: ${err.message}`);
      clearStreamingState();
      resolve();
    });

    child.on('close', (code) => {
      activeChild = null;
      // Fallback: if result handler didn't fire, finalize whatever we have
      if (!entryWritten && accumulatedText.trim() && code === 0) {
        try {
          feedDb.prepare('INSERT INTO feed_entries (text, tokens_used) VALUES (?, ?)').run(accumulatedText.trim(), tokensUsed);
          log(`Entry written from close handler: ${accumulatedText.trim().slice(0, 80)}...`);
        } catch (err) { log(`Close handler DB write error: ${err.message}`); }
      }
      clearStreamingState();
      resolve();
    });

    // Safety timeout: SIGKILL after 2 minutes (SIGTERM insufficient — claude -p ignores it)
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* */ }
    }, 120_000);
  });
}

// ============================================================================
// Cleanup
// ============================================================================

function pruneOldEntries(feedDb) {
  try {
    const count = feedDb.prepare('SELECT COUNT(*) as c FROM feed_entries').get().c;
    if (count > MAX_ENTRIES) {
      const cutoff = count - MAX_ENTRIES;
      feedDb.prepare('DELETE FROM feed_entries WHERE id IN (SELECT id FROM feed_entries ORDER BY id ASC LIMIT ?)').run(cutoff);
      log(`Pruned ${cutoff} old entries`);
    }
  } catch { /* */ }
}

// ============================================================================
// Poll Cycle
// ============================================================================

let generating = false;

async function pollCycle(feedDb) {
  if (generating) {
    log('Previous generation still in progress, skipping');
    return;
  }

  const fingerprint = getActivityFingerprint();
  if (!fingerprint || fingerprint === lastFingerprint) {
    return; // No new activity
  }
  lastFingerprint = fingerprint;

  log('Activity detected, generating entry...');
  generating = true;

  try {
    const ctx = gatherContext();

    // Read previous entries for context
    const prevEntries = feedDb.prepare(
      'SELECT text, created_at FROM feed_entries ORDER BY id DESC LIMIT 10'
    ).all().reverse();

    const prompt = buildPrompt(ctx, prevEntries);
    await generateEntry(prompt, feedDb);
    pruneOldEntries(feedDb);
  } catch (err) {
    log(`Poll error: ${err.message}`);
    clearStreamingState();
  } finally {
    generating = false;
  }
}

// ============================================================================
// Entry Point
// ============================================================================

const feedDb = initFeedDb();
clearStreamingState();

log('Live feed daemon starting');
log(`Project: ${PROJECT_DIR}`);
log(`Poll interval: ${POLL_INTERVAL_MS / 1000}s`);

// Initial poll after 5s
setTimeout(() => pollCycle(feedDb).catch(err => log(`Initial poll error: ${err.message}`)), 5000);

// Recurring poll
setInterval(() => {
  pollCycle(feedDb).catch(err => log(`Poll error: ${err.message}`));
}, POLL_INTERVAL_MS);

// Kill active child process before exit to prevent orphans
function killActiveChild() {
  if (activeChild && activeChild.pid) {
    try { process.kill(activeChild.pid, 'SIGKILL'); } catch { /* ESRCH */ }
    activeChild = null;
  }
}

// Graceful shutdown — kill child BEFORE exit
process.on('SIGTERM', () => {
  log('Shutting down (SIGTERM)');
  killActiveChild();
  clearStreamingState();
  closeDb(feedDb);
  process.exit(0);
});

process.on('SIGINT', () => {
  log('Shutting down (SIGINT)');
  killActiveChild();
  clearStreamingState();
  closeDb(feedDb);
  process.exit(0);
});
