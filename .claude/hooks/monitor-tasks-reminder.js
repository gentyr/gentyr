#!/usr/bin/env node
/**
 * PostToolUse Hook: Monitor Tasks Reminder
 *
 * Fires every 10 tool calls when /monitor-tasks is active, injecting a
 * reminder into the CTO's monitoring session to keep it on track.
 *
 * Fast-exit when .claude/state/monitor-tasks-active.json does not exist
 * (zero overhead for non-monitoring sessions).
 *
 * Every 10 calls: compact one-liner reminder.
 * Every 30 calls: full protocol reminder with all steps.
 *
 * Counter persisted at .claude/state/monitor-tasks-reminder.count
 *
 * @version 1.0.0
 */

import { createInterface } from 'readline';
import fs from 'fs';
import path from 'path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_DIR = path.join(PROJECT_DIR, '.claude', 'state');
const STATE_FILE = path.join(STATE_DIR, 'monitor-tasks-active.json');

// Fast-exit: if state file doesn't exist, there is no active /monitor-tasks session.
if (!fs.existsSync(STATE_FILE)) {
  console.log(JSON.stringify({}));
  process.exit(0);
}

const COUNTER_FILE = path.join(STATE_DIR, 'monitor-tasks-reminder.count');
const COMPACT_INTERVAL = 10;
const FULL_INTERVAL = 30;

async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    const rl = createInterface({ input: process.stdin });
    rl.on('line', (line) => { data += line; });
    rl.on('close', () => { resolve(data); });
    // Safety timeout — never block the hook pipeline
    setTimeout(() => { rl.close(); resolve(data); }, 200);
  });
}

function readCounter() {
  try {
    const raw = fs.readFileSync(COUNTER_FILE, 'utf8').trim();
    return parseInt(raw, 10) || 0;
  } catch (_) {
    return 0;
  }
}

function writeCounter(n) {
  try {
    if (!fs.existsSync(STATE_DIR)) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
    }
    fs.writeFileSync(COUNTER_FILE, String(n), 'utf8');
  } catch (_) {
    // Non-fatal
  }
}

function readStateFile() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

async function main() {
  // Safety timeout: ensure we always exit within 4 seconds
  const safetyTimer = setTimeout(() => {
    console.log(JSON.stringify({}));
    process.exit(0);
  }, 4000);
  safetyTimer.unref();

  // Consume stdin (PostToolUse contract)
  await readStdin();

  // Re-check state file after stdin drain (race condition: file deleted mid-drain)
  if (!fs.existsSync(STATE_FILE)) {
    console.log(JSON.stringify({}));
    process.exit(0);
  }

  const state = readStateFile();
  if (!state) {
    console.log(JSON.stringify({}));
    process.exit(0);
  }

  // Increment counter
  const counter = readCounter() + 1;
  writeCounter(counter);

  // Only fire on multiples of COMPACT_INTERVAL
  if (counter % COMPACT_INTERVAL !== 0) {
    console.log(JSON.stringify({}));
    process.exit(0);
  }

  const roundNumber = state.roundNumber ?? '?';
  const currentStep = state.currentStep ?? '?';
  const monitoredSessions = Array.isArray(state.monitoredSessions) && state.monitoredSessions.length > 0
    ? state.monitoredSessions.join(', ')
    : '(none)';
  const monitoredTaskIds = Array.isArray(state.monitoredTaskIds) && state.monitoredTaskIds.length > 0
    ? state.monitoredTaskIds.join(', ')
    : '(none)';

  const isFull = counter % FULL_INTERVAL === 0;

  let additionalContext;

  if (!isFull) {
    // Compact reminder every 10 calls
    additionalContext = [
      `[MONITOR-TASKS] Round ${roundNumber}. Sessions: ${monitoredSessions}. Step: ${currentStep}.`,
      `Remember: call browse_session to show raw indexed messages. Do NOT summarize — the CTO wants verbatim session content.`,
    ].join(' ');
  } else {
    // Full protocol reminder every 30 calls
    additionalContext = `[MONITOR-TASKS — FULL PROTOCOL REMINDER]
You are running /monitor-tasks. Your job is to show the CTO raw session data, not summaries.

EACH ROUND (5+ steps):
1. OVERVIEW: call inspect_persistent_task for each task ID — check planContext, isPlanManager, categoryId fields
2. PLAN GRAPH (if plan-managed): show plan dependency table from planContext. For plan managers, also call get_spawn_ready_tasks to show what's ready to spawn next. Show categoryName instead of section on child sessions when available.
3. BROWSE: call browse_session for each active session (latest 15-20 messages). Preview the output, adjust offset to find the most diagnostic window. Show raw indexed messages to the CTO.
4. QUEUE: call get_session_queue_status
5. ASSESS: Write 3-5 sentences with specific evidence from steps 1-4
6. SLEEP 60s, repeat

Monitored tasks: ${monitoredTaskIds}
Monitored sessions: ${monitoredSessions}
Current round: ${roundNumber}

CRITICAL RULES:
- Show browse_session output verbatim — numbered messages with timestamps
- Do NOT spawn investigator sub-agents — call MCP tools directly
- Do NOT paraphrase or summarize session messages
- Continue looping until all monitored sessions are done or CTO interrupts
- Update .claude/state/monitor-tasks-active.json each round
- For plan-managed tasks, show the plan dependency graph each round`;
  }

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext,
    },
  }));

  process.exit(0);
}

main().catch(() => {
  console.log(JSON.stringify({}));
  process.exit(0);
});
