#!/usr/bin/env node
/**
 * SessionStart Hook: Session Briefing
 *
 * Injects a comprehensive situational awareness briefing at session start.
 *
 * For interactive (deputy-CTO) sessions: queue state, recent CTO prompts,
 * agent communications, git state, plan progress, and task counts.
 *
 * For spawned agent sessions: mandatory pre-work protocol including task
 * context, active sessions, recent CTO directives, and git activity.
 *
 * IMPORTANT: This hook MUST NEVER write to stderr. All errors route to
 * systemMessage in the JSON stdout response.
 *
 * @version 1.0.0
 */

import { createInterface } from 'readline';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const IS_SPAWNED = process.env.CLAUDE_SPAWNED_SESSION === 'true';
const AGENT_ID = process.env.CLAUDE_AGENT_ID || null;

// DB paths
const QUEUE_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'session-queue.db');
const FOCUS_MODE_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'focus-mode.json');
const USER_PROMPTS_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'user-prompts.db');
const PLANS_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'plans.db');
const TODO_DB_PATH = path.join(PROJECT_DIR, '.claude', 'todo.db');
const SESSION_COMMS_LOG = path.join(PROJECT_DIR, '.claude', 'state', 'session-comms.log');

// Lazy SQLite
let Database = null;
try {
  Database = (await import('better-sqlite3')).default;
} catch (_) {
  // Non-fatal — briefing degrades gracefully without SQLite
}

// ---------------------------------------------------------------------------
// Stdin reader (SessionStart hook contract)
// ---------------------------------------------------------------------------

async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    const rl = createInterface({ input: process.stdin });
    rl.on('line', (line) => { data += line; });
    rl.on('close', () => { resolve(data); });
    // Timeout safety — don't block session start
    setTimeout(() => { rl.close(); resolve(data); }, 200);
  });
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function safeExecSync(cmd, opts = {}) {
  try {
    return execSync(cmd, {
      timeout: 5000,
      encoding: 'utf8',
      stdio: 'pipe',
      cwd: PROJECT_DIR,
      ...opts,
    }).trim();
  } catch (_) {
    return null;
  }
}

function elapsedStr(isoTimestamp) {
  if (!isoTimestamp) return '?';
  const ms = Date.now() - new Date(isoTimestamp).getTime();
  if (ms < 0) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function waitStr(isoTimestamp) {
  if (!isoTimestamp) return '?';
  const ms = Date.now() - new Date(isoTimestamp).getTime();
  if (ms < 0) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

function timeAgoStr(isoTimestamp) {
  return elapsedStr(isoTimestamp) + ' ago';
}

function truncate(str, maxLen) {
  if (!str) return '';
  const s = str.replace(/\s+/g, ' ').trim();
  return s.length <= maxLen ? s : s.slice(0, maxLen - 1) + '\u2026';
}

// ---------------------------------------------------------------------------
// Data gathering: focus mode
// ---------------------------------------------------------------------------

function getFocusModeState() {
  try {
    if (!fs.existsSync(FOCUS_MODE_PATH)) return null;
    const state = JSON.parse(fs.readFileSync(FOCUS_MODE_PATH, 'utf8'));
    if (state.enabled === true) return state;
    return null;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Data gathering: session queue
// ---------------------------------------------------------------------------

function getQueueState() {
  if (!Database || !fs.existsSync(QUEUE_DB_PATH)) {
    return null;
  }
  try {
    const db = new Database(QUEUE_DB_PATH, { readonly: true });

    const maxRow = db.prepare("SELECT value FROM queue_config WHERE key = 'max_concurrent_sessions'").get();
    const maxSessions = maxRow ? parseInt(maxRow.value, 10) : 10;

    const running = db.prepare(
      "SELECT id, title, agent_type, spawned_at, metadata FROM queue_items WHERE status = 'running' ORDER BY spawned_at ASC LIMIT 15"
    ).all();

    const queued = db.prepare(
      "SELECT id, title, priority, enqueued_at FROM queue_items WHERE status = 'queued' ORDER BY priority DESC, enqueued_at ASC LIMIT 10"
    ).all();

    const suspended = db.prepare(
      "SELECT id, title, priority FROM queue_items WHERE status = 'suspended' ORDER BY enqueued_at ASC LIMIT 5"
    ).all();

    db.close();

    return { maxSessions, running, queued, suspended };
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Data gathering: recent CTO prompts (last N hours)
// ---------------------------------------------------------------------------

function getRecentCtoPrompts(hours = 1) {
  if (!Database || !fs.existsSync(USER_PROMPTS_DB_PATH)) {
    return [];
  }
  try {
    const db = new Database(USER_PROMPTS_DB_PATH, { readonly: true });
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const rows = db.prepare(
      "SELECT content, timestamp FROM user_prompts WHERE timestamp > ? ORDER BY timestamp DESC LIMIT 5"
    ).all(since);
    db.close();
    return rows;
  } catch (_) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Data gathering: recent agent communications
// ---------------------------------------------------------------------------

function getRecentComms(maxLines = 5) {
  if (!fs.existsSync(SESSION_COMMS_LOG)) {
    return { count: 0, lines: [] };
  }
  try {
    const content = fs.readFileSync(SESSION_COMMS_LOG, 'utf8');
    const lines = content.split('\n').filter(l => l.trim()).slice(-maxLines);
    return { count: lines.length, lines };
  } catch (_) {
    return { count: 0, lines: [] };
  }
}

// ---------------------------------------------------------------------------
// Data gathering: git state
// ---------------------------------------------------------------------------

function getGitState() {
  const branch = safeExecSync('git rev-parse --abbrev-ref HEAD');
  const status = safeExecSync('git status --porcelain');
  const recentCommits = safeExecSync('git log --oneline -5 --no-walk=unsorted 2>/dev/null || git log --oneline -5');

  // Parse worktrees
  let worktrees = [];
  try {
    const wtRaw = safeExecSync('git worktree list --porcelain');
    if (wtRaw) {
      const wts = wtRaw.split('\n\n').filter(Boolean);
      for (const wt of wts) {
        const pathMatch = wt.match(/^worktree (.+)$/m);
        const branchMatch = wt.match(/^branch refs\/heads\/(.+)$/m);
        if (pathMatch && branchMatch) {
          worktrees.push({ path: pathMatch[1], branch: branchMatch[1] });
        }
      }
    }
  } catch (_) {
    // Non-fatal
  }

  const dirtyCount = status ? status.split('\n').filter(Boolean).length : 0;
  const statusStr = dirtyCount > 0 ? `${dirtyCount} uncommitted` : 'clean';

  return { branch, statusStr, recentCommits, worktrees };
}

// ---------------------------------------------------------------------------
// Data gathering: plans
// ---------------------------------------------------------------------------

function getPlansState() {
  if (!Database || !fs.existsSync(PLANS_DB_PATH)) {
    return [];
  }
  try {
    const db = new Database(PLANS_DB_PATH, { readonly: true });
    const plans = db.prepare(
      "SELECT id, title FROM plans WHERE status = 'active' ORDER BY updated_at DESC LIMIT 5"
    ).all();

    const result = [];
    for (const plan of plans) {
      const taskTotal = db.prepare(
        "SELECT COUNT(*) as count FROM plan_tasks WHERE plan_id = ?"
      ).get(plan.id);
      const taskComplete = db.prepare(
        "SELECT COUNT(*) as count FROM plan_tasks WHERE plan_id = ? AND status = 'completed'"
      ).get(plan.id);
      const readyCount = db.prepare(
        "SELECT COUNT(*) as count FROM plan_tasks WHERE plan_id = ? AND status = 'ready'"
      ).get(plan.id);

      const pct = taskTotal.count > 0
        ? Math.round((taskComplete.count / taskTotal.count) * 100)
        : 0;

      result.push({
        title: plan.title,
        pct,
        readyCount: readyCount.count,
        totalTasks: taskTotal.count,
      });
    }
    db.close();
    return result;
  } catch (_) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Data gathering: task counts
// ---------------------------------------------------------------------------

function getTaskCounts() {
  if (!Database || !fs.existsSync(TODO_DB_PATH)) {
    return null;
  }
  try {
    const db = new Database(TODO_DB_PATH, { readonly: true });
    const pending = db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'pending'").get();
    const active = db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'in_progress'").get();

    // Completed in last 24h
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const completed24h = db.prepare(
      "SELECT COUNT(*) as count FROM tasks WHERE status = 'completed' AND completed_at > ?"
    ).get(since);

    db.close();
    return {
      pending: pending?.count || 0,
      active: active?.count || 0,
      completed24h: completed24h?.count || 0,
    };
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Data gathering: persistent task state
// ---------------------------------------------------------------------------

function getPersistentTaskState() {
  const ptDbPath = path.join(PROJECT_DIR, '.claude', 'state', 'persistent-tasks.db');
  if (!Database || !fs.existsSync(ptDbPath)) {
    return null;
  }
  try {
    const db = new Database(ptDbPath, { readonly: true });
    const active = db.prepare(
      "SELECT id, title, status, monitor_pid, last_heartbeat, cycle_count FROM persistent_tasks WHERE status = 'active'"
    ).all();

    if (active.length === 0) {
      db.close();
      return null;
    }

    const result = [];
    let monitorsAlive = 0;
    let monitorsDead = 0;

    for (const task of active) {
      let alive = false;
      if (task.monitor_pid) {
        try { process.kill(task.monitor_pid, 0); alive = true; } catch (_) { /* dead */ }
      }
      if (alive) monitorsAlive++;
      else monitorsDead++;

      // Count pending amendments
      const amendments = db.prepare(
        "SELECT COUNT(*) as cnt FROM amendments WHERE persistent_task_id = ? AND acknowledged_at IS NULL"
      ).get(task.id);

      result.push({
        title: task.title,
        monitorAlive: alive,
        pendingAmendments: amendments?.cnt || 0,
        cycle: task.cycle_count || 0,
      });
    }

    db.close();
    return { tasks: result, monitorsAlive, monitorsDead };
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Data gathering: current task details (for spawned sessions)
// ---------------------------------------------------------------------------

function getCurrentTaskDetails() {
  if (!AGENT_ID || !Database || !fs.existsSync(TODO_DB_PATH)) {
    return null;
  }
  try {
    const db = new Database(TODO_DB_PATH, { readonly: true });
    // Find the in_progress task associated with this agent via the queue
    if (fs.existsSync(QUEUE_DB_PATH)) {
      const qdb = new Database(QUEUE_DB_PATH, { readonly: true });
      const qItem = qdb.prepare(
        "SELECT metadata FROM queue_items WHERE agent_id = ? AND status = 'running'"
      ).get(AGENT_ID);
      qdb.close();

      if (qItem && qItem.metadata) {
        try {
          const meta = JSON.parse(qItem.metadata);
          if (meta.task_id) {
            const task = db.prepare(
              "SELECT id, title, section, priority, description FROM tasks WHERE id = ?"
            ).get(meta.task_id);
            db.close();
            return task || null;
          }
        } catch (_) {
          // Non-fatal
        }
      }
    }

    // Fallback: find any in_progress task (most recently started)
    const task = db.prepare(
      "SELECT id, title, section, priority, description FROM tasks WHERE status = 'in_progress' ORDER BY started_at DESC LIMIT 1"
    ).get();
    db.close();
    return task || null;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Data gathering: git activity (last 2h for spawned sessions)
// ---------------------------------------------------------------------------

function getGitActivity(hours = 2) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ');
  const log = safeExecSync(`git log --oneline --after="${since}" --all 2>/dev/null || git log --oneline -5`);
  return log || null;
}

// ---------------------------------------------------------------------------
// Briefing builders
// ---------------------------------------------------------------------------

function buildInteractiveBriefing() {
  const lines = ['[DEPUTY-CTO SESSION BRIEFING]', ''];

  // Focus mode notice (prominent — shown before queue state)
  const focusMode = getFocusModeState();
  if (focusMode) {
    lines.push('[FOCUS MODE ACTIVE] Only CTO-directed tasks, persistent monitors, and revivals can spawn. Run /focus-mode to disable.');
    lines.push('');
  }

  // Queue state
  const queue = getQueueState();
  if (queue) {
    const runCount = queue.running.length;
    const queueCount = queue.queued.length;
    const suspendedCount = queue.suspended.length;
    lines.push(`Queue: ${runCount}/${queue.maxSessions} running, ${queueCount} queued, ${suspendedCount} suspended`);

    if (queue.running.length > 0) {
      lines.push('  Running:');
      for (const item of queue.running) {
        let lastTool = '';
        try {
          const meta = item.metadata ? JSON.parse(item.metadata) : {};
          if (meta.last_tool) lastTool = ` \u2014 last: ${meta.last_tool}`;
        } catch (_) {
          // Non-fatal
        }
        lines.push(`    - "${truncate(item.title, 60)}" (${item.agent_type}, ${elapsedStr(item.spawned_at)})${lastTool}`);
      }
    }

    if (queue.queued.length > 0) {
      lines.push('  Queued:');
      for (const item of queue.queued) {
        lines.push(`    - "${truncate(item.title, 60)}" (${item.priority}, ${waitStr(item.enqueued_at)} wait)`);
      }
    }

    if (queue.suspended.length > 0) {
      lines.push('  Suspended:');
      for (const item of queue.suspended) {
        lines.push(`    - "${truncate(item.title, 60)}" (will resume at ${item.priority} priority)`);
      }
    }
  } else {
    lines.push('Queue: unavailable');
  }

  lines.push('');

  // Recent CTO prompts
  const prompts = getRecentCtoPrompts(1);
  if (prompts.length > 0) {
    lines.push('Recent CTO prompts (last 1h):');
    for (const p of prompts) {
      lines.push(`  - "${truncate(p.content, 100)}"`);
    }
  } else {
    lines.push('Recent CTO prompts (last 1h): none');
  }

  lines.push('');

  // Agent communications
  const comms = getRecentComms(5);
  if (comms.count > 0) {
    lines.push(`Recent agent communications: ${comms.count} new`);
    lines.push('  Use mcp__agent-tracker__get_comms_log for details');
  } else {
    lines.push('Recent agent communications: none');
  }

  lines.push('');

  // Git state
  const git = getGitState();
  const worktreeCount = git.worktrees.length;
  const gitLine = [
    git.branch ? `Git: ${git.branch}` : 'Git: unknown branch',
    `(${git.statusStr})`,
    `${worktreeCount} active worktree${worktreeCount !== 1 ? 's' : ''}`,
  ].join(', ');
  lines.push(gitLine);

  // Plans
  const plans = getPlansState();
  if (plans.length > 0) {
    const planParts = plans.map(p => `"${truncate(p.title, 40)}" ${p.pct}% | ${p.readyCount} tasks ready`);
    lines.push(`Plans: ${planParts.join(' | ')}`);
  }

  // Task counts
  const tasks = getTaskCounts();
  if (tasks) {
    lines.push(`Tasks: ${tasks.pending} pending, ${tasks.active} active, ${tasks.completed24h} completed (24h)`);
  }

  // Persistent tasks
  const ptState = getPersistentTaskState();
  if (ptState) {
    lines.push(`PERSISTENT TASKS: ${ptState.tasks.length} active | ${ptState.monitorsAlive} monitor(s) alive${ptState.monitorsDead > 0 ? `, ${ptState.monitorsDead} DEAD` : ''}`);
    for (const t of ptState.tasks) {
      const monStatus = t.monitorAlive ? 'running' : 'DEAD';
      const amendStr = t.pendingAmendments > 0 ? `, ${t.pendingAmendments} pending amendment(s)` : '';
      lines.push(`  "${truncate(t.title, 50)}" — monitor ${monStatus}${amendStr}`);
    }
  }

  lines.push('');
  lines.push('Hint: Use mcp__agent-tracker__peek_session to drill into any session.');
  lines.push('      Use mcp__agent-tracker__send_session_signal to communicate with agents.');
  lines.push('      Use mcp__show__show_session-queue for the full queue widget.');

  return lines.join('\n');
}

function buildSpawnedBriefing() {
  const lines = ['[SESSION BRIEFING \u2014 MANDATORY PRE-WORK PROTOCOL]', ''];

  // Task context
  const task = getCurrentTaskDetails();
  if (task) {
    lines.push(`You are starting work on: "${truncate(task.title, 80)}"`);
    lines.push(`Task ID: ${task.id} | Section: ${task.section} | Priority: ${task.priority}`);
  } else {
    lines.push('You are starting a new work session.');
  }

  lines.push('');
  lines.push('BEFORE doing ANY work on your task, you MUST complete these steps IN ORDER:');
  lines.push('');
  lines.push('1. INVESTIGATOR AGENT: Spawn the investigator sub-agent to understand the context');
  lines.push('   of other recent and ongoing sessions.');
  lines.push('');
  lines.push('2. USER-ALIGNMENT AGENT (first pass): Spawn the user-alignment sub-agent to verify');
  lines.push('   your task aligns with CTO intent.');
  lines.push('');
  lines.push('3. REVIEW ACTIVE SESSIONS: Call mcp__agent-tracker__get_session_activity_summary.');
  lines.push('');
  lines.push('4. CHECK SIGNALS: Call mcp__agent-tracker__get_session_signals.');
  lines.push('');
  lines.push('5. ONLY THEN: Begin working on your assigned task.');

  lines.push('');

  // Active sessions from queue
  const queue = getQueueState();
  if (queue && queue.running.length > 0) {
    lines.push('Active sessions:');
    for (const item of queue.running) {
      let lastTool = '';
      try {
        const meta = item.metadata ? JSON.parse(item.metadata) : {};
        if (meta.last_tool) lastTool = ` \u2014 ${meta.last_tool}`;
      } catch (_) {
        // Non-fatal
      }
      lines.push(`  - "${truncate(item.title, 60)}" (${item.agent_type}, ${elapsedStr(item.spawned_at)})${lastTool}`);
    }
  } else {
    lines.push('Active sessions: none');
  }

  lines.push('');

  // Recent CTO directives
  const prompts = getRecentCtoPrompts(4);
  if (prompts.length > 0) {
    lines.push('Recent CTO directives:');
    for (const p of prompts) {
      lines.push(`  - "${truncate(p.content, 120)}" (${timeAgoStr(p.timestamp)})`);
    }
  } else {
    lines.push('Recent CTO directives: none in last 4h');
  }

  lines.push('');

  // Git activity
  const gitActivity = getGitActivity(2);
  if (gitActivity) {
    lines.push('Git activity (last 2h):');
    for (const commitLine of gitActivity.split('\n').slice(0, 5)) {
      if (commitLine.trim()) lines.push(`  ${commitLine}`);
    }
  }

  // Worktrees
  const git = getGitState();
  if (git.worktrees.length > 0) {
    lines.push('');
    lines.push(`Worktrees: ${git.worktrees.length} active`);
    for (const wt of git.worktrees.slice(0, 5)) {
      lines.push(`  - ${wt.path} (${wt.branch})`);
    }
  }

  lines.push('');
  lines.push('REMINDER: When done, follow the completion protocol:');
  lines.push('  user-alignment \u2192 project-manager \u2192 verify merge \u2192 user-alignment (final) \u2192 summarize_work');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await readStdin();

  let briefing;
  let errors = [];

  if (IS_SPAWNED) {
    try {
      briefing = buildSpawnedBriefing();
    } catch (err) {
      errors.push(`spawned briefing error: ${err.message}`);
      briefing = '[SESSION BRIEFING] Could not generate full briefing. Check session-briefing.js logs.\n\nREMINDER: When done, follow the completion protocol:\n  user-alignment \u2192 project-manager \u2192 verify merge \u2192 user-alignment (final) \u2192 summarize_work';
    }
  } else {
    try {
      briefing = buildInteractiveBriefing();
    } catch (err) {
      errors.push(`interactive briefing error: ${err.message}`);
      briefing = '[DEPUTY-CTO SESSION BRIEFING] Could not generate full briefing. Check session-briefing.js.';
    }
  }

  const lineCount = briefing.split('\n').length;
  const systemMessage = errors.length > 0
    ? `[session-briefing] ${lineCount} lines injected (errors: ${errors.join('; ')})`
    : `[session-briefing] ${lineCount} lines injected`;

  console.log(JSON.stringify({
    continue: true,
    systemMessage,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: briefing,
    },
  }));

  process.exit(0);
}

main().catch(() => {
  console.log(JSON.stringify({ continue: true }));
  process.exit(0);
});
