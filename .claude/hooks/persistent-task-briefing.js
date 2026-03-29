#!/usr/bin/env node
/**
 * Persistent Task Briefing Hook
 *
 * PostToolUse hook that reinforces the persistent task prompt, amendments,
 * and monitoring protocol for persistent monitor sessions.
 *
 * Fast-exit when GENTYR_PERSISTENT_TASK_ID is not set (zero overhead for other sessions).
 * Full injection every 5 tool calls; compact one-liner on intermediate calls.
 * Also updates heartbeat and cycle_count on the persistent_tasks row.
 *
 * @version 1.0.0
 */

import { createInterface } from 'readline';
import fs from 'fs';
import path from 'path';
import { debugLog } from './lib/debug-log.js';

// Fast exit: if not a persistent monitor session, exit immediately
const PERSISTENT_TASK_ID = process.env.GENTYR_PERSISTENT_TASK_ID;
if (!PERSISTENT_TASK_ID) {
  // Output valid hook response and exit
  console.log(JSON.stringify({ }));
  process.exit(0);
}

let Database = null;
try {
  Database = (await import('better-sqlite3')).default;
} catch (_) {
  console.log(JSON.stringify({ }));
  process.exit(0);
}

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const PT_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
const TODO_DB_PATH = path.join(PROJECT_DIR, '.claude', 'todo.db');
const AGENT_ID = process.env.CLAUDE_AGENT_ID || 'unknown';
const COUNTER_FILE = path.join(PROJECT_DIR, '.claude', 'state', `persistent-briefing-${AGENT_ID}.count`);
const FULL_INTERVAL = 5;

async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    const rl = createInterface({ input: process.stdin });
    rl.on('line', (line) => { data += line; });
    rl.on('close', () => { resolve(data); });
    setTimeout(() => { rl.close(); resolve(data); }, 200);
  });
}

function getCounter() {
  try {
    return parseInt(fs.readFileSync(COUNTER_FILE, 'utf8').trim(), 10) || 0;
  } catch (_) { return 0; }
}

function setCounter(n) {
  try {
    const dir = path.dirname(COUNTER_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(COUNTER_FILE, String(n));
  } catch (_) { /* non-fatal */ }
}

function elapsedStr(isoTimestamp) {
  if (!isoTimestamp) return '?';
  const ms = Date.now() - new Date(isoTimestamp).getTime();
  if (ms < 0) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

async function main() {
  await readStdin(); // consume stdin (hook contract)

  if (!fs.existsSync(PT_DB_PATH)) {
    console.log(JSON.stringify({ }));
    process.exit(0);
  }

  const counter = getCounter() + 1;
  setCounter(counter);

  let db;
  try {
    db = new Database(PT_DB_PATH);
    db.pragma('busy_timeout = 3000');
  } catch (_) {
    console.log(JSON.stringify({ }));
    process.exit(0);
  }

  // Read persistent task
  const task = db.prepare("SELECT * FROM persistent_tasks WHERE id = ?").get(PERSISTENT_TASK_ID);
  if (!task) {
    db.close();
    console.log(JSON.stringify({ }));
    process.exit(0);
  }

  // If task is no longer active, tell the monitor to exit immediately
  if (task.status !== 'active') {
    db.close();
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `[PERSISTENT MONITOR — EXIT NOW] Your persistent task "${task.title}" (${PERSISTENT_TASK_ID}) has status "${task.status}". You MUST stop all work and exit immediately. Do NOT create new sub-tasks or continue monitoring. Call summarize_work and exit.`,
      },
    }));
    process.exit(0);
  }

  // Update heartbeat every call
  db.prepare("UPDATE persistent_tasks SET last_heartbeat = ?, cycle_count = cycle_count + 1 WHERE id = ?")
    .run(new Date().toISOString(), PERSISTENT_TASK_ID);

  const isFull = counter % FULL_INTERVAL === 0;
  debugLog('persistent-task-briefing', 'cycle', { taskId: PERSISTENT_TASK_ID, cycle: task.cycle_count + 1, isFull });

  if (!isFull) {
    // Compact briefing
    const amendmentCount = db.prepare("SELECT COUNT(*) as cnt FROM amendments WHERE persistent_task_id = ?").get(PERSISTENT_TASK_ID).cnt;
    const unacknowledged = db.prepare("SELECT COUNT(*) as cnt FROM amendments WHERE persistent_task_id = ? AND acknowledged_at IS NULL").get(PERSISTENT_TASK_ID).cnt;

    // Get sub-task counts from todo.db
    let subtaskSummary = '';
    try {
      const subtaskIds = db.prepare("SELECT todo_task_id FROM sub_tasks WHERE persistent_task_id = ?").all(PERSISTENT_TASK_ID);
      if (subtaskIds.length > 0) {
        const todoDb = new Database(TODO_DB_PATH, { readonly: true });
        const placeholders = subtaskIds.map(() => '?').join(',');
        const ids = subtaskIds.map(r => r.todo_task_id);
        const completed = todoDb.prepare(`SELECT COUNT(*) as cnt FROM tasks WHERE id IN (${placeholders}) AND status = 'completed'`).get(...ids).cnt;
        const inProgress = todoDb.prepare(`SELECT COUNT(*) as cnt FROM tasks WHERE id IN (${placeholders}) AND status = 'in_progress'`).get(...ids).cnt;
        subtaskSummary = ` Sub-tasks: ${completed}/${subtaskIds.length} done, ${inProgress} active.`;
        todoDb.close();
      }
    } catch (_) { /* non-fatal */ }

    db.close();
    const amendStr = unacknowledged > 0 ? ` ${unacknowledged} unacknowledged amendment(s)!` : '';
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `[PERSISTENT MONITOR] Cycle ${task.cycle_count + 1}.${subtaskSummary}${amendStr} Check signals.`,
      },
    }));
    process.exit(0);
  }

  // Full briefing
  const amendments = db.prepare(
    "SELECT * FROM amendments WHERE persistent_task_id = ? ORDER BY created_at ASC"
  ).all(PERSISTENT_TASK_ID);

  // Get sub-task details from todo.db
  let subtaskDetails = '';
  try {
    const subtaskIds = db.prepare("SELECT todo_task_id FROM sub_tasks WHERE persistent_task_id = ?").all(PERSISTENT_TASK_ID);
    if (subtaskIds.length > 0) {
      const todoDb = new Database(TODO_DB_PATH, { readonly: true });
      const details = [];
      let completed = 0, inProgress = 0, pending = 0;
      for (const row of subtaskIds) {
        const t = todoDb.prepare("SELECT id, title, status, section FROM tasks WHERE id = ?").get(row.todo_task_id);
        if (t) {
          details.push(`- [${t.status}] "${t.title}" (${t.section})`);
          if (t.status === 'completed') completed++;
          else if (t.status === 'in_progress') inProgress++;
          else pending++;
        }
      }
      todoDb.close();
      subtaskDetails = `\n## Sub-Task Status\nCompleted: ${completed} | In Progress: ${inProgress} | Pending: ${pending}\n${details.join('\n')}`;
    }
  } catch (_) { /* non-fatal */ }

  db.close();

  // Build full context
  let amendmentSection = '';
  if (amendments.length > 0) {
    const lines = amendments.map((a, i) => {
      const ack = a.acknowledged_at ? '' : ' [UNACKNOWLEDGED]';
      return `${i + 1}. [${a.amendment_type}, ${a.created_at}] "${a.content}" — ${a.created_by}${ack}`;
    });
    amendmentSection = `\n## Amendments (in chronological order)\n${lines.join('\n')}`;
  }

  // Check if task involves demos (for conditional visual verification reminder)
  let isDemoInvolved = false;
  try {
    const meta = task.metadata ? JSON.parse(task.metadata) : {};
    isDemoInvolved = !!meta.demo_involved;
  } catch (_) { /* non-fatal */ }

  const demoReminder = isDemoInvolved ? `

## Demo Visual Verification Reminder
- Have you analyzed screenshots from the latest demo run?
- After check_demo_result, did you follow the analysis_guidance?
- Did you use the Read tool to view failure_frames or get_demo_screenshot images?
- Screenshot analysis is MANDATORY before code investigation or spawning fix tasks.
- You are multimodal -- use Read on image files to see browser state directly.` : '';

  const fullContext = `[PERSISTENT TASK MONITOR — CYCLE REINFORCEMENT]

## Your Persistent Task
Title: ${task.title}
Outcome: ${task.outcome_criteria || '(not specified)'}
Status: ${task.status} | Cycle: ${task.cycle_count + 1} | Uptime: ${elapsedStr(task.activated_at)}

## Original Prompt
${task.prompt}
${amendmentSection}
${subtaskDetails}

## Monitoring Protocol
1. Check sub-task progress: mcp__todo-db__list_tasks
2. Check for signals: mcp__agent-tracker__get_session_signals
3. If all done → evaluate outcome criteria → mcp__persistent-task__complete_persistent_task
4. If new work needed → create sub-tasks in appropriate sections
5. Run user-alignment check every 3 cycles
6. Report progress every 5 cycles via mcp__agent-reports__report_to_deputy_cto
7. All sub-tasks MUST include persistent_task_id: "${PERSISTENT_TASK_ID}" in create_task
8. Acknowledge ALL amendments: mcp__persistent-task__acknowledge_amendment${demoReminder}`;

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: fullContext,
    },
  }));
  process.exit(0);
}

main().catch(() => {
  console.log(JSON.stringify({ }));
  process.exit(0);
});
