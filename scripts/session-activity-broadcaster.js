#!/usr/bin/env node
/**
 * Session Activity Broadcaster Daemon
 *
 * Every 5 minutes:
 *   1. Reads running sessions from session-queue.db
 *   2. For each session, reads the session JSONL tail for recent activity
 *   3. Concurrent LLM calls (one per session) to summarize activity
 *   4. Stores per-session summaries in session-activity.db
 *   5. One LLM call to create a unified super-summary
 *   6. Stores the super-summary
 *   7. Broadcasts to all agents via broadcastSignal()
 *
 * Uses `claude -p --model haiku` (Max subscription, no API key).
 * Runs as a launchd KeepAlive service.
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);

// ============================================================================
// Configuration
// ============================================================================

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_DIR = path.join(PROJECT_DIR, '.claude', 'state');
const LOG_FILE = path.join(PROJECT_DIR, '.claude', 'session-activity-broadcaster.log');
const QUEUE_DB_PATH = path.join(STATE_DIR, 'session-queue.db');
const ACTIVITY_DB_PATH = path.join(STATE_DIR, 'session-activity.db');
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const LLM_TIMEOUT_MS = 60000;
const TAIL_BYTES = 16384; // 16KB tail per session
const LLM_MODEL = 'haiku';

const SESSION_SYSTEM_PROMPT = 'You are a concise activity summarizer. Given recent activity from a Claude Code agent session, produce a brief summary (2-4 sentences) of what the agent is working on, what it recently accomplished, and what it appears to be doing next. Focus on high-granularity recent activity. Be specific about file names, functions, and tool usage. Output plain text only, no markdown.';

const SUPER_SYSTEM_PROMPT = 'You are a project coordinator. Given individual session summaries from multiple concurrent Claude Code agents, produce ONE concise paragraph (3-5 sentences) summarizing the overall project activity. Highlight connections between sessions, potential coordination opportunities, and the overall direction of work. Output plain text only, no markdown.';

// ============================================================================
// Logging
// ============================================================================

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch { /* best-effort */ }
}

// ============================================================================
// Database Initialization (daemon owns this DB)
// ============================================================================

function initActivityDb() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const db = new Database(ACTIVITY_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_summaries (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      agent_id TEXT,
      queue_id TEXT,
      title TEXT,
      summary TEXT,
      model TEXT,
      tokens_used INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ss_session ON session_summaries(session_id);
    CREATE INDEX IF NOT EXISTS idx_ss_agent ON session_summaries(agent_id);
    CREATE INDEX IF NOT EXISTS idx_ss_created ON session_summaries(created_at);

    CREATE TABLE IF NOT EXISTS project_summaries (
      id TEXT PRIMARY KEY,
      summary TEXT,
      session_count INTEGER,
      model TEXT,
      tokens_used INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ps_created ON project_summaries(created_at);
  `);
  return db;
}

// ============================================================================
// Session Discovery
// ============================================================================

function getRunningSessionsFromQueue() {
  if (!fs.existsSync(QUEUE_DB_PATH)) return [];
  let db;
  try {
    db = new Database(QUEUE_DB_PATH, { readonly: true });
    return db.prepare(
      "SELECT id, agent_id, agent_type, title, project_dir, worktree_path, metadata FROM queue_items WHERE status = 'running'"
    ).all();
  } catch (err) {
    log(`Error reading session-queue.db: ${err.message}`);
    return [];
  } finally {
    try { db?.close(); } catch { /* */ }
  }
}

// ============================================================================
// Session File Discovery (mirrors agent-tracker pattern)
// ============================================================================

function getSessionDir(projectDir) {
  const encoded = projectDir.replace(/\//g, '-');
  const sessionDir = path.join(CLAUDE_PROJECTS_DIR, encoded);
  if (fs.existsSync(sessionDir)) return sessionDir;
  // Try without leading dash
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
      const buf = Buffer.alloc(2048);
      const bytesRead = fs.readSync(fd, buf, 0, 2048, 0);
      if (buf.toString('utf8', 0, bytesRead).includes(marker)) return filePath;
    } catch { /* skip */ }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  return null;
}

function findSessionFile(session) {
  const projectDir = session.worktree_path || session.project_dir || PROJECT_DIR;
  const dir = getSessionDir(projectDir);
  if (!dir || !session.agent_id) return null;
  return findSessionFileByAgentId(dir, session.agent_id);
}

// ============================================================================
// Session Tail Reading
// ============================================================================

function readTailBytes(filePath, bytes = TAIL_BYTES) {
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

function parseTailEntries(tail) {
  return tail.split('\n').filter(l => l.trim()).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function extractActivityText(entries) {
  const lines = [];
  for (const entry of entries) {
    const content = entry?.message?.content;
    if (!content) continue;

    if (typeof content === 'string') {
      if (content.trim()) lines.push(`[text] ${content.slice(0, 200)}`);
      continue;
    }

    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text?.trim()) {
          lines.push(`[assistant] ${block.text.slice(0, 200)}`);
        } else if (block.type === 'tool_use') {
          const inputStr = JSON.stringify(block.input || {}).slice(0, 100);
          lines.push(`[tool] ${block.name || 'unknown'}(${inputStr})`);
        } else if (block.type === 'tool_result') {
          const resultText = typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '');
          lines.push(`[result] ${resultText.slice(0, 100)}`);
        }
      }
    }
  }
  // Return last entries (most recent activity first for the LLM)
  return lines.slice(-60).join('\n').slice(0, 4000);
}

// ============================================================================
// LLM Calls
// ============================================================================

async function callLLM(prompt, systemPrompt) {
  // Pass prompt as -p argument, not stdin. execFile does NOT support the `input` option
  // (only exec/execSync do). Passing via stdin silently drops the data.
  const args = ['-p', prompt, '--model', LLM_MODEL, '--output-format', 'json'];
  if (systemPrompt) args.push('--system-prompt', systemPrompt);

  try {
    const { stdout } = await execFileAsync('claude', args, {
      encoding: 'utf8',
      timeout: LLM_TIMEOUT_MS,
    });
    const data = JSON.parse(stdout);
    return {
      text: data.result || '',
      tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
    };
  } catch (err) {
    log(`LLM call failed: ${err.message}`);
    return null;
  }
}

// ============================================================================
// Broadcast Message Builder
// ============================================================================

function buildBroadcastMessage(superSummary, sessionSummaries) {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const sessionLines = sessionSummaries.map(s =>
    `- ${s.title || 'Untitled'}: ${s.id} (${(s.summary || '').slice(0, 120)})`
  ).join('\n');

  return `[SESSION ACTIVITY BROADCAST — ${timestamp}]

${superSummary}

Session details (use mcp__session-activity__get_session_summary with UUID):
${sessionLines}

If your work relates to any session above, use mcp__agent-tracker__send_session_signal or mcp__agent-tracker__broadcast_signal to coordinate. Cross-session coordination prevents duplicate work and merge conflicts.

Full project summary history: mcp__session-activity__list_project_summaries / mcp__session-activity__get_project_summary`;
}

// ============================================================================
// Main Poll Cycle
// ============================================================================

async function pollCycle() {
  const sessions = getRunningSessionsFromQueue();
  if (sessions.length === 0) return;

  log(`Found ${sessions.length} running session(s), generating summaries...`);

  // Build prompts for each session
  const sessionPrompts = [];
  for (const session of sessions) {
    const file = findSessionFile(session);
    if (!file) continue;

    const tail = readTailBytes(file);
    const entries = parseTailEntries(tail);
    const activityText = extractActivityText(entries);
    if (!activityText.trim()) continue;

    sessionPrompts.push({
      session,
      prompt: `Session title: ${session.title || 'Untitled'}\nAgent type: ${session.agent_type || 'unknown'}\n\nRecent activity:\n${activityText}`,
    });
  }

  if (sessionPrompts.length === 0) {
    log('No session activity to summarize');
    return;
  }

  // Concurrent LLM calls for per-session summaries
  const summaryResults = await Promise.allSettled(
    sessionPrompts.map(({ prompt }) => callLLM(prompt, SESSION_SYSTEM_PROMPT))
  );

  // Store successful summaries
  const storedSummaries = [];
  const insertStmt = activityDb.prepare(
    'INSERT INTO session_summaries (id, session_id, agent_id, queue_id, title, summary, model, tokens_used) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );

  for (let i = 0; i < summaryResults.length; i++) {
    const result = summaryResults[i];
    if (result.status !== 'fulfilled' || !result.value) continue;

    const { session } = sessionPrompts[i];
    const { text, tokens } = result.value;
    if (!text.trim()) continue;

    const id = randomUUID();
    try {
      insertStmt.run(id, null, session.agent_id, session.id, session.title, text, LLM_MODEL, tokens);
      storedSummaries.push({ id, title: session.title, summary: text });
    } catch (err) {
      log(`DB insert failed for session ${session.id}: ${err.message}`);
    }
  }

  if (storedSummaries.length === 0) {
    log('No summaries generated (all LLM calls failed or returned empty)');
    return;
  }

  log(`Generated ${storedSummaries.length} session summary/summaries`);

  // Super-summary: one LLM call covering all sessions
  const superPrompt = 'Active sessions:\n\n' +
    storedSummaries.map(s => `- [${s.title || 'Untitled'}]: ${s.summary}`).join('\n\n');

  const superResult = await callLLM(superPrompt, SUPER_SYSTEM_PROMPT);
  let superSummaryText = '';
  if (superResult?.text) {
    superSummaryText = superResult.text;
    const superId = randomUUID();
    try {
      activityDb.prepare(
        'INSERT INTO project_summaries (id, summary, session_count, model, tokens_used) VALUES (?, ?, ?, ?, ?)'
      ).run(superId, superSummaryText, storedSummaries.length, LLM_MODEL, superResult.tokens);
      log(`Generated project super-summary (${storedSummaries.length} sessions)`);
    } catch (err) {
      log(`Super-summary DB insert failed: ${err.message}`);
    }
  } else {
    // Fallback: concatenate session summaries
    superSummaryText = storedSummaries.map(s => `${s.title}: ${s.summary}`).join(' | ');
  }

  // Broadcast to all running agents
  try {
    if (!broadcastSignalFn) {
      const mod = await import(path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'session-signals.js'));
      broadcastSignalFn = mod.broadcastSignal;
    }
    const message = buildBroadcastMessage(superSummaryText, storedSummaries);
    broadcastSignalFn({
      fromAgentId: 'session-activity-broadcaster',
      tier: 'note',
      message,
      projectDir: PROJECT_DIR,
    });
    log(`Broadcast sent to running agents`);
  } catch (err) {
    log(`Broadcast failed: ${err.message}`);
  }
}

// ============================================================================
// Entry Point
// ============================================================================

const activityDb = initActivityDb();
let broadcastSignalFn = null;

log('Session activity broadcaster daemon starting');
log(`Project: ${PROJECT_DIR}`);
log(`Poll interval: ${POLL_INTERVAL_MS / 1000}s`);

// Initial poll
pollCycle().catch(err => log(`Initial poll error: ${err.message}`));

// Recurring poll
setInterval(() => {
  pollCycle().catch(err => log(`Poll error: ${err.message}`));
}, POLL_INTERVAL_MS);

// Graceful shutdown
process.on('SIGTERM', () => {
  log('Session activity broadcaster shutting down (SIGTERM)');
  try { activityDb.close(); } catch { /* */ }
  process.exit(0);
});

process.on('SIGINT', () => {
  log('Session activity broadcaster shutting down (SIGINT)');
  try { activityDb.close(); } catch { /* */ }
  process.exit(0);
});
