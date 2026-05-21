#!/usr/bin/env node
/**
 * Monitor Poll Budget Hook (PostToolUse on peek_session)
 *
 * Tracks `peek_session` call frequency per spawned monitor session and emits
 * a soft warning when calls exceed the configured budget within a rolling
 * window. The actual budget enforcement is in the agent docs
 * (persistent-monitor.md, plan-manager.md) — this hook surfaces violations
 * to the agent so it can self-correct.
 *
 * Budget defaults:
 *   - 5 peek_session calls per 5-min rolling window per monitor session
 *   - Warning emitted on the 6th call within that window
 *   - State persists to .claude/state/monitor-poll-budget.json (atomic write)
 *
 * Skips:
 *   - Interactive (CTO) sessions — they're observers, not monitors
 *   - Spawned sessions without GENTYR_PERSISTENT_TASK_ID — only monitors are budgeted
 *
 * Fast exit: under 1ms when tool is not peek_session, or session is not a monitor.
 */

import fs from 'fs';
import path from 'path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_FILE = path.join(PROJECT_DIR, '.claude', 'state', 'monitor-poll-budget.json');

const WINDOW_MS = 5 * 60 * 1000;     // 5 minutes
const BUDGET = 5;                     // calls per window before warning
const NUDGE_COOLDOWN_MS = 60 * 1000;  // don't repeat a nudge within 60s

/**
 * Atomic JSON write — tmp + rename. Read returns null on any error.
 */
function readState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const tmp = `${STATE_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STATE_FILE);
  } catch {
    // Non-fatal — budget tracking is advisory only.
  }
}

function emit(output) {
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

/**
 * Main hook entry.
 */
async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    emit({ continue: true });
    return;
  }

  const toolName = input?.tool_name || input?.tool || '';
  // Fast exit: only fire on peek_session
  if (!/(?:^|__)peek_session$/.test(toolName)) {
    emit({ continue: true });
    return;
  }

  // Skip interactive sessions — only spawned monitors are budgeted.
  const persistentTaskId = process.env.GENTYR_PERSISTENT_TASK_ID;
  const isSpawned = process.env.CLAUDE_SPAWNED_SESSION === 'true';
  if (!isSpawned || !persistentTaskId) {
    emit({ continue: true });
    return;
  }

  const sessionId = input?.session_id || process.env.CLAUDE_SESSION_ID || persistentTaskId;
  const now = Date.now();

  const state = readState();
  const entry = state[sessionId] || { calls: [], lastNudgeAt: 0 };

  // Drop calls outside the rolling window.
  entry.calls = entry.calls.filter((ts) => now - ts < WINDOW_MS);
  entry.calls.push(now);

  // Trim per-session entries to avoid runaway growth.
  if (entry.calls.length > 100) entry.calls = entry.calls.slice(-100);

  state[sessionId] = entry;

  // GC: drop entries with no recent activity.
  for (const [sid, e] of Object.entries(state)) {
    if (!e.calls || e.calls.length === 0) delete state[sid];
    else if (now - e.calls[e.calls.length - 1] > WINDOW_MS * 2) delete state[sid];
  }

  writeState(state);

  // Emit warning when over budget, with cooldown so it doesn't spam every call.
  if (entry.calls.length > BUDGET && now - entry.lastNudgeAt > NUDGE_COOLDOWN_MS) {
    entry.lastNudgeAt = now;
    writeState(state);

    const message = [
      `=== POLLING BUDGET EXCEEDED ===`,
      ``,
      `You've made ${entry.calls.length} peek_session calls in the last 5 minutes.`,
      `The per-cycle budget is 1 inspect_persistent_task + at most 2 peek_session calls.`,
      ``,
      `peek_session is for DEEP DIVES, not routine monitoring. You are auto-subscribed`,
      `to verbatim child summaries via the broadcaster every 5 minutes — those arrive`,
      `automatically through signal-reader, no polling required.`,
      ``,
      `If all children are running normally with recent activity:`,
      `  - Sleep between cycles: bash -c "sleep 60"`,
      `  - Or exit the session with summarize_work — the orphan catch-all will`,
      `    re-spawn you when something actually changes.`,
      ``,
      `See agents/persistent-monitor.md "Per-Cycle Polling Budget" for the full rules.`,
    ].join('\n');

    emit({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: message,
      },
    });
    return;
  }

  emit({ continue: true });
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

main().catch(() => emit({ continue: true }));
