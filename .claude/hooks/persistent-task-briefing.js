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

  const isFull = counter % FULL_INTERVAL === 0;
  debugLog('persistent-task-briefing', 'cycle', { taskId: PERSISTENT_TASK_ID, cycle: task.cycle_count + 1, isFull });

  if (!isFull) {
    // Compact briefing
    const amendmentCount = db.prepare("SELECT COUNT(*) as cnt FROM amendments WHERE persistent_task_id = ?").get(PERSISTENT_TASK_ID).cnt;
    const unacknowledged = db.prepare("SELECT COUNT(*) as cnt FROM amendments WHERE persistent_task_id = ? AND acknowledged_at IS NULL").get(PERSISTENT_TASK_ID).cnt;

    // Get sub-task counts from todo.db
    let completedCount = 0, inProgressCount = 0, totalCount = 0;
    let subtaskSummary = '';
    try {
      const subtaskIds = db.prepare("SELECT todo_task_id FROM sub_tasks WHERE persistent_task_id = ?").all(PERSISTENT_TASK_ID);
      if (subtaskIds.length > 0) {
        totalCount = subtaskIds.length;
        const todoDb = new Database(TODO_DB_PATH, { readonly: true });
        const placeholders = subtaskIds.map(() => '?').join(',');
        const ids = subtaskIds.map(r => r.todo_task_id);
        completedCount = todoDb.prepare(`SELECT COUNT(*) as cnt FROM tasks WHERE id IN (${placeholders}) AND status = 'completed'`).get(...ids).cnt;
        inProgressCount = todoDb.prepare(`SELECT COUNT(*) as cnt FROM tasks WHERE id IN (${placeholders}) AND status = 'in_progress'`).get(...ids).cnt;
        // Last 3 active task titles for summary
        const active = todoDb.prepare(`SELECT title FROM tasks WHERE id IN (${placeholders}) AND status = 'in_progress' LIMIT 3`).all(...ids);
        subtaskSummary = ` Sub-tasks: ${completedCount}/${totalCount} done, ${inProgressCount} active.`;
        todoDb.close();

        // Build heartbeat summary from compact cycle data
        const summaryParts = [`Sub-tasks: ${completedCount}/${totalCount} done, ${inProgressCount} active, ${totalCount - completedCount - inProgressCount} pending`];
        if (active.length > 0) summaryParts.push(`Active: ${active.map(t => `"${t.title}"`).join(', ')}`);
        if (unacknowledged > 0) summaryParts.push(`${unacknowledged} unacknowledged amendment(s)`);
        const uptime = task.activated_at ? Math.round((Date.now() - new Date(task.activated_at).getTime()) / 60000) : 0;
        summaryParts.push(`Cycle: ${(task.cycle_count || 0) + 1}, Uptime: ${Math.floor(uptime / 60)}h ${uptime % 60}m`);
        const summary = summaryParts.join('. ').slice(0, 500);
        db.prepare("UPDATE persistent_tasks SET last_heartbeat = ?, cycle_count = cycle_count + 1, last_summary = ? WHERE id = ?")
          .run(new Date().toISOString(), summary, PERSISTENT_TASK_ID);
      } else {
        // No subtasks — still write heartbeat with minimal summary
        const uptime = task.activated_at ? Math.round((Date.now() - new Date(task.activated_at).getTime()) / 60000) : 0;
        const summary = `No sub-tasks yet. Cycle: ${(task.cycle_count || 0) + 1}, Uptime: ${Math.floor(uptime / 60)}h ${uptime % 60}m`;
        db.prepare("UPDATE persistent_tasks SET last_heartbeat = ?, cycle_count = cycle_count + 1, last_summary = ? WHERE id = ?")
          .run(new Date().toISOString(), summary, PERSISTENT_TASK_ID);
      }
    } catch (_) {
      // Non-fatal — write heartbeat without summary on error
      db.prepare("UPDATE persistent_tasks SET last_heartbeat = ?, cycle_count = cycle_count + 1 WHERE id = ?")
        .run(new Date().toISOString(), PERSISTENT_TASK_ID);
    }

    db.close();
    const amendStr = unacknowledged > 0 ? ` ${unacknowledged} unacknowledged amendment(s)!` : '';
    const skepticismNudge = completedCount > 0 ? ' VERIFY: Did completed children prove their results (exit codes, screenshots, PR merges)? Don\'t take their word for it.' : '';

    // Compact plan context for plan manager sessions
    let compactPlanStr = '';
    try {
      const meta = task.metadata ? JSON.parse(task.metadata) : {};
      if (meta.plan_task_id && meta.plan_id) {
        const planDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'plans.db');
        if (fs.existsSync(planDbPath)) {
          const planDb = new Database(planDbPath, { readonly: true });
          const planTaskRow = planDb.prepare('SELECT title FROM plan_tasks WHERE id = ?').get(meta.plan_task_id);
          const planTaskStats = planDb.prepare(
            "SELECT COUNT(*) as total, SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as done FROM plan_tasks WHERE plan_id = ?"
          ).get(meta.plan_id);
          planDb.close();
          if (planTaskRow) {
            const ptDone = planTaskStats?.done || 0;
            const ptTotal = planTaskStats?.total || 0;
            compactPlanStr = ` [PLAN: "${planTaskRow.title}" — ${ptDone}/${ptTotal} tasks done]`;
          }
        }
      }
    } catch (_) { /* non-fatal */ }

    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `[PERSISTENT MONITOR] Cycle ${task.cycle_count + 1}.${subtaskSummary}${amendStr} Check signals.${skepticismNudge}${compactPlanStr}`,
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
  let fullCompletedCount = 0, fullInProgressCount = 0, fullPendingCount = 0, fullTotalCount = 0;
  let fullActiveTitles = [];
  try {
    const subtaskIds = db.prepare("SELECT todo_task_id FROM sub_tasks WHERE persistent_task_id = ?").all(PERSISTENT_TASK_ID);
    fullTotalCount = subtaskIds.length;
    if (subtaskIds.length > 0) {
      const todoDb = new Database(TODO_DB_PATH, { readonly: true });
      const details = [];
      for (const row of subtaskIds) {
        const t = todoDb.prepare("SELECT id, title, status, section, category_id FROM tasks WHERE id = ?").get(row.todo_task_id);
        if (t) {
          details.push(`- [${t.status}] "${t.title}" (${t.category_id || t.section})`);
          if (t.status === 'completed') fullCompletedCount++;
          else if (t.status === 'in_progress') { fullInProgressCount++; if (fullActiveTitles.length < 3) fullActiveTitles.push(t.title); }
          else fullPendingCount++;
        }
      }
      todoDb.close();
      subtaskDetails = `\n## Sub-Task Status\nCompleted: ${fullCompletedCount} | In Progress: ${fullInProgressCount} | Pending: ${fullPendingCount}\n${details.join('\n')}`;
    }
  } catch (_) { /* non-fatal */ }

  // Build and write heartbeat summary from full cycle data
  try {
    const summaryParts = [];
    if (fullTotalCount > 0) {
      summaryParts.push(`Sub-tasks: ${fullCompletedCount}/${fullTotalCount} done, ${fullInProgressCount} active, ${fullPendingCount} pending`);
      if (fullActiveTitles.length > 0) summaryParts.push(`Active: ${fullActiveTitles.map(t => `"${t}"`).join(', ')}`);
    }
    const unackCount = amendments.filter(a => !a.acknowledged_at).length;
    if (unackCount > 0) summaryParts.push(`${unackCount} unacknowledged amendment(s)`);
    const uptime = task.activated_at ? Math.round((Date.now() - new Date(task.activated_at).getTime()) / 60000) : 0;
    summaryParts.push(`Cycle: ${(task.cycle_count || 0) + 1}, Uptime: ${Math.floor(uptime / 60)}h ${uptime % 60}m`);
    const summary = summaryParts.join('. ').slice(0, 500);
    db.prepare("UPDATE persistent_tasks SET last_heartbeat = ?, cycle_count = cycle_count + 1, last_summary = ? WHERE id = ?")
      .run(new Date().toISOString(), summary, PERSISTENT_TASK_ID);
  } catch (_) {
    // Non-fatal — write heartbeat without summary on error
    db.prepare("UPDATE persistent_tasks SET last_heartbeat = ?, cycle_count = cycle_count + 1 WHERE id = ?")
      .run(new Date().toISOString(), PERSISTENT_TASK_ID);
  }

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

  // Parse metadata once for demo + plan context
  let isDemoInvolved = false;
  let planContextSection = '';
  try {
    const meta = task.metadata ? JSON.parse(task.metadata) : {};
    isDemoInvolved = !!meta.demo_involved;

    // Plan context injection for plan manager sessions
    if (meta.plan_task_id && meta.plan_id) {
      const planDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'plans.db');
      if (fs.existsSync(planDbPath)) {
        try {
          const planDb = new Database(planDbPath, { readonly: true });
          const planTask = planDb.prepare('SELECT title, status FROM plan_tasks WHERE id = ?').get(meta.plan_task_id);
          const plan = planDb.prepare('SELECT title, status FROM plans WHERE id = ?').get(meta.plan_id);

          // Substep progress
          const substepStats = planDb.prepare(
            'SELECT COUNT(*) as total, SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END) as done FROM substeps WHERE task_id = ?'
          ).get(meta.plan_task_id);

          // Plan-level task progress
          const planTaskStats = planDb.prepare(
            "SELECT COUNT(*) as total, SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as done FROM plan_tasks WHERE plan_id = ?"
          ).get(meta.plan_id);

          planDb.close();

          if (plan && planTask) {
            const subDone = substepStats?.done || 0;
            const subTotal = substepStats?.total || 0;
            const ptDone = planTaskStats?.done || 0;
            const ptTotal = planTaskStats?.total || 0;
            planContextSection = `

## Plan Context
You are executing step "${planTask.title}" (status: ${planTask.status}) of plan "${plan.title}".
Plan progress: ${ptDone}/${ptTotal} tasks completed.
Substeps for this task: ${subDone}/${subTotal} complete.
After each milestone, spawn Task(subagent_type='plan-updater') to sync progress.
When this task is done, call mcp__persistent-task__complete_persistent_task — the plan-persistent-sync hook will auto-advance the plan.`;
          }
        } catch (_) { /* non-fatal */ }
      }
    }
  } catch (_) { /* non-fatal */ }

  const demoReminder = isDemoInvolved ? `

## Demo Visual Verification Reminder
- Have you analyzed screenshots from the latest demo run?
- After check_demo_result, did you follow the analysis_guidance?
- Did you use the Read tool to view failure_frames or get_demo_screenshot images?
- Screenshot analysis is MANDATORY before code investigation or spawning fix tasks.
- You are multimodal -- use Read on image files to see browser state directly.` : '';

  // Amendment compliance check (every 10 full cycles)
  let amendmentComplianceWarning = '';
  if (amendments.length > 0 && (task.cycle_count || 0) % 10 === 0) {
    try {
      const recentCorrections = amendments.filter(
        a => a.amendment_type === 'correction' && a.acknowledged_at &&
        (Date.now() - new Date(a.created_at).getTime()) < 6 * 60 * 60 * 1000 // last 6 hours
      );
      if (recentCorrections.length > 0 && fullTotalCount > 0) {
        const todoDb = new Database(TODO_DB_PATH, { readonly: true });
        for (const amendment of recentCorrections) {
          const amendTime = amendment.created_at;
          // Check if any sub-task was created AFTER this amendment
          const postAmendTasks = todoDb.prepare(
            "SELECT COUNT(*) as cnt FROM tasks WHERE id IN (SELECT todo_task_id FROM sub_tasks WHERE persistent_task_id = ?) AND created_at > ?"
          ).get(PERSISTENT_TASK_ID, amendTime);
          if (!postAmendTasks || postAmendTasks.cnt === 0) {
            const preview = (amendment.content || '').slice(0, 150);
            amendmentComplianceWarning += `\nUNACTED AMENDMENT WARNING: Correction from ${amendTime} has no sub-tasks created after it: "${preview}..."`;
          }
        }
        todoDb.close();
      }
    } catch (_) { /* non-fatal */ }
  }

  // Scope guard: warn when sub-task count is high with low completion rate
  let scopeWarning = '';
  if (fullTotalCount > 30 && fullCompletedCount / fullTotalCount < 0.20) {
    scopeWarning = `

## SCOPE WARNING
This task has ${fullTotalCount} sub-tasks with only ${Math.round(fullCompletedCount / fullTotalCount * 100)}% completion rate.
Consider requesting CTO scope review via submit_bypass_request with category: 'scope'.
The current approach may need decomposition into smaller, focused tasks targeting specific root causes.`
  }

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
1. Check sub-task progress: mcp__agent-tracker__inspect_persistent_task (primary) or mcp__todo-db__list_tasks (fallback)
2. VERIFY completed children: mcp__agent-tracker__peek_session to examine what they actually did — demand evidence
3. Check for signals: mcp__agent-tracker__get_session_signals
4. If all done → evaluate outcome criteria → mcp__persistent-task__complete_persistent_task
5. If new work needed → create sub-tasks in appropriate sections
6. Run user-alignment check every 3 cycles
7. Report progress every 5 cycles via mcp__agent-reports__report_to_deputy_cto
8. All sub-tasks MUST include persistent_task_id: "${PERSISTENT_TASK_ID}" in create_task
9. Acknowledge ALL amendments: mcp__persistent-task__acknowledge_amendment

## Skepticism Protocol (MANDATORY)
- Do NOT accept child agents' claims at face value. When a child says "test passed" or "demo working", deep-dive its session with peek_session and look for exit codes, screenshots, assertion output
- Absence of errors is NOT proof of success — demand positive evidence (exit code 0, specific output strings, confirmed UI state)
- If a child completed without verification evidence, send it a directive demanding proof, or create a new task to re-verify
- Use mcp__agent-tracker__peek_session({ agent_id: "<id>", depth: 32 }) to read the child's actual session JSONL — see what it really did, not just what it claimed${planContextSection}${demoReminder}${scopeWarning}${amendmentComplianceWarning}`;

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
