#!/usr/bin/env node
/**
 * UserPromptSubmit Hook: CTO Prompt Detector
 *
 * Only for interactive (non-spawned) sessions. Detects CTO prompts and:
 * 1. Writes a signal file to .claude/state/cto-prompt-signal.json
 * 2. Checks todo.db for in-progress tasks that might be affected
 * 3. Broadcasts a notification to running agents via session-signals (if available)
 *
 * Never blocks the user's prompt — always outputs { continue: true }.
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_DIR = path.join(PROJECT_DIR, '.claude', 'state');
const CTO_SIGNAL_FILE = path.join(STATE_DIR, 'cto-prompt-signal.json');
const TODO_DB_PATH = path.join(PROJECT_DIR, '.claude', 'todo.db');

// Lazy SQLite
let Database = null;
try {
  Database = (await import('better-sqlite3')).default;
} catch (_) {
  // Non-fatal
}

/**
 * Read stdin as text. UserPromptSubmit hooks receive JSON with the prompt.
 */
async function readStdinText() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => { resolve(data); });
    // Safety timeout
    setTimeout(() => { resolve(data); }, 200);
  });
}

/**
 * Extract prompt text from the hook's stdin input.
 * UserPromptSubmit hooks receive: { session_id, user_prompt } or plain text.
 */
function extractPrompt(raw) {
  if (!raw || !raw.trim()) return '';
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.user_prompt === 'string') return parsed.user_prompt;
    if (typeof parsed.prompt === 'string') return parsed.prompt;
  } catch (_) {
    // Not JSON — use raw string
  }
  return raw.trim();
}

/**
 * Extract session_id from the hook's stdin input.
 */
function extractSessionId(raw) {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed.session_id || null;
  } catch (_) {
    return null;
  }
}

/**
 * Find in-progress tasks that might be related to the prompt content.
 * Uses simple keyword matching — top 3 words from the prompt.
 */
function findRelatedTasks(promptContent) {
  if (!Database || !fs.existsSync(TODO_DB_PATH)) {
    return [];
  }
  try {
    const db = new Database(TODO_DB_PATH, { readonly: true });
    const tasks = db.prepare(
      "SELECT id, title, section FROM tasks WHERE status = 'in_progress' ORDER BY started_at DESC LIMIT 20"
    ).all();
    db.close();

    if (tasks.length === 0) return [];

    // Extract keywords from prompt (words longer than 4 chars, not stopwords)
    const STOPWORDS = new Set(['this', 'that', 'with', 'from', 'have', 'will', 'about', 'when', 'what', 'where', 'which', 'there', 'their', 'would', 'could', 'should', 'please', 'make', 'sure', 'need', 'want', 'also', 'just', 'like', 'into', 'than', 'then', 'only', 'some', 'more', 'your', 'very', 'been']);
    const keywords = promptContent
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 4 && !STOPWORDS.has(w))
      .slice(0, 5);

    if (keywords.length === 0) return tasks.slice(0, 3);

    // Match tasks that contain any keyword
    const matched = tasks.filter(t => {
      const titleLower = (t.title || '').toLowerCase();
      return keywords.some(kw => titleLower.includes(kw));
    });

    return matched.length > 0 ? matched.slice(0, 5) : tasks.slice(0, 3);
  } catch (_) {
    return [];
  }
}

/**
 * Broadcast a signal to running agents via session-signals module.
 * Gracefully skips if the module is not available.
 */
async function tryBroadcast(preview, projectDir) {
  try {
    const signalsPath = path.join(projectDir, '.claude', 'hooks', 'lib', 'session-signals.js');
    if (!fs.existsSync(signalsPath)) {
      return; // WS4 not installed — skip silently
    }
    const { broadcastSignal } = await import(signalsPath);
    await broadcastSignal({
      fromAgentId: 'cto-interactive',
      fromAgentType: 'cto',
      fromTaskTitle: 'CTO Interactive Session',
      tier: 'note',
      message: `New CTO activity: "${preview}". Check if this affects your work. Consider running the user-alignment agent.`,
      projectDir,
    });
  } catch (_) {
    // Non-fatal — signal broadcast is best-effort
  }
}

async function main() {
  const raw = await readStdinText();

  // Skip for spawned sessions
  if (process.env.CLAUDE_SPAWNED_SESSION === 'true') {
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  const promptContent = extractPrompt(raw);
  const sessionId = extractSessionId(raw);

  // Skip slash commands and empty prompts
  if (!promptContent || /^\/[\w-]+/.test(promptContent.trim())) {
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  const preview = promptContent.slice(0, 200).replace(/\s+/g, ' ').trim();
  const now = new Date().toISOString();

  // Write signal file
  try {
    if (!fs.existsSync(STATE_DIR)) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
    }
    const signal = {
      content_preview: preview,
      timestamp: now,
      session_id: sessionId || null,
    };
    fs.writeFileSync(CTO_SIGNAL_FILE, JSON.stringify(signal, null, 2), 'utf8');
  } catch (_) {
    // Non-fatal
  }

  // Check for related in-progress tasks
  const relatedTasks = findRelatedTasks(promptContent);

  // Broadcast to running agents if there are related tasks
  if (relatedTasks.length > 0) {
    // Fire-and-forget — don't await, don't block
    tryBroadcast(preview, PROJECT_DIR).catch(() => {
      // Swallow errors — signal is best-effort
    });
  }

  // Never block the user's prompt
  console.log(JSON.stringify({ continue: true }));
  process.exit(0);
}

main().catch(() => {
  console.log(JSON.stringify({ continue: true }));
  process.exit(0);
});
