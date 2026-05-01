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
import { execSync, execFileSync } from 'child_process';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const IS_SPAWNED = process.env.CLAUDE_SPAWNED_SESSION === 'true';
const AGENT_ID = process.env.CLAUDE_AGENT_ID || null;

// DB paths
const QUEUE_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'session-queue.db');
const FOCUS_MODE_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'focus-mode.json');
const LOCAL_MODE_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'local-mode.json');
const USER_PROMPTS_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'user-prompts.db');
const PLANS_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'plans.db');
const TODO_DB_PATH = path.join(PROJECT_DIR, '.claude', 'todo.db');
const SESSION_COMMS_LOG = path.join(PROJECT_DIR, '.claude', 'state', 'session-comms.log');
const BYPASS_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'bypass-requests.db');
const RELEASE_LEDGER_DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'release-ledger.db');

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

function getLocalModeState() {
  try {
    if (!fs.existsSync(LOCAL_MODE_PATH)) return null;
    const state = JSON.parse(fs.readFileSync(LOCAL_MODE_PATH, 'utf8'));
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
// Data gathering: preview → staging drift
// ---------------------------------------------------------------------------

/**
 * Get preview → staging drift info.
 * Uses automation state file for speed (no git subprocess on every session start).
 * Falls back to git if state file is unavailable.
 */
function getPreviewStagingDrift() {
  // Fast path: read from automation state file
  try {
    const statePath = path.join(PROJECT_DIR, '.claude', 'state', 'hourly-automation-state.json');
    if (fs.existsSync(statePath)) {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (typeof state.previewStagingDriftCount === 'number') {
        return {
          count: state.previewStagingDriftCount,
          ageHours: state.previewStagingOldestDriftAge || null,
        };
      }
    }
  } catch { /* fall through to git */ }

  // Slow path: git
  try {
    execSync('git fetch origin preview staging --quiet 2>/dev/null || true', {
      cwd: PROJECT_DIR, encoding: 'utf8', timeout: 15000, stdio: 'pipe',
    });
    const result = execSync('git rev-list --count origin/staging..origin/preview 2>/dev/null', {
      cwd: PROJECT_DIR, encoding: 'utf8', timeout: 5000, stdio: 'pipe',
    }).trim();
    const count = parseInt(result, 10) || 0;
    if (count === 0) return { count: 0, ageHours: null };
    return { count, ageHours: null };
  } catch { return null; }
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
// Data gathering: blocking queue
// ---------------------------------------------------------------------------

function getBlockingQueue() {
  if (!Database) return null;
  const dbPath = path.join(PROJECT_DIR, '.claude', 'state', 'bypass-requests.db');
  if (!fs.existsSync(dbPath)) return null;
  try {
    const db = new Database(dbPath, { readonly: true });
    db.pragma('busy_timeout = 1000');
    // Check if blocking_queue table exists
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='blocking_queue'").get();
    if (!tableExists) { db.close(); return null; }
    const items = db.prepare(
      "SELECT id, blocking_level, summary, plan_id, plan_title, persistent_task_id, plan_task_id, impact_assessment, created_at, bypass_request_id FROM blocking_queue WHERE status = 'active' ORDER BY CASE blocking_level WHEN 'plan' THEN 0 WHEN 'persistent_task' THEN 1 WHEN 'task' THEN 2 END, created_at ASC"
    ).all();
    db.close();
    return items.length > 0 ? items : null;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Data gathering: pending CTO bypass requests
// ---------------------------------------------------------------------------

function getPendingBypassRequests() {
  if (!Database || !fs.existsSync(BYPASS_DB_PATH)) return null;
  try {
    const db = new Database(BYPASS_DB_PATH, { readonly: true });
    db.pragma('busy_timeout = 1000');
    const requests = db.prepare(
      "SELECT id, task_type, task_id, task_title, category, summary, created_at FROM bypass_requests WHERE status = 'pending' ORDER BY created_at ASC"
    ).all();
    db.close();
    return requests.length > 0 ? requests : null;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Data gathering: pending deferred protected actions
// ---------------------------------------------------------------------------

function getPendingDeferredActions() {
  if (!Database || !fs.existsSync(BYPASS_DB_PATH)) return null;
  try {
    const db = new Database(BYPASS_DB_PATH, { readonly: true });
    db.pragma('busy_timeout = 1000');
    // Check if deferred_actions table exists
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='deferred_actions'").get();
    if (!tableExists) { db.close(); return null; }
    const actions = db.prepare(
      "SELECT id, server, tool, args, code, phrase, requester_agent_id, created_at FROM deferred_actions WHERE status = 'pending' ORDER BY created_at ASC"
    ).all();
    db.close();
    return actions.length > 0 ? actions : null;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Data gathering: active production release
// ---------------------------------------------------------------------------

function getActiveRelease() {
  if (!Database || !fs.existsSync(RELEASE_LEDGER_DB_PATH)) return null;
  try {
    const db = new Database(RELEASE_LEDGER_DB_PATH, { readonly: true });
    db.pragma('busy_timeout = 3000');
    const release = db.prepare(
      "SELECT * FROM releases WHERE status = 'in_progress' LIMIT 1"
    ).get();
    if (!release) { db.close(); return null; }

    // Count PRs
    const prCount = db.prepare(
      "SELECT COUNT(*) as count FROM release_prs WHERE release_id = ?"
    ).get(release.id);

    db.close();

    // Determine current phase from plans.db if plan_id is set
    let currentPhase = '?';
    let totalPhases = '?';
    if (release.plan_id && fs.existsSync(PLANS_DB_PATH)) {
      try {
        const planDb = new Database(PLANS_DB_PATH, { readonly: true });
        planDb.pragma('busy_timeout = 3000');
        const completedPhases = planDb.prepare(
          "SELECT COUNT(*) as count FROM phases WHERE plan_id = ? AND status IN ('completed', 'skipped')"
        ).get(release.plan_id);
        const allPhases = planDb.prepare(
          "SELECT COUNT(*) as count FROM phases WHERE plan_id = ?"
        ).get(release.plan_id);
        planDb.close();
        currentPhase = String((completedPhases?.count || 0) + 1);
        totalPhases = String(allPhases?.count || '?');
      } catch (_) {
        // Non-fatal — plan DB access failure
      }
    }

    return {
      id: release.id,
      version: release.version || 'unversioned',
      stagingLockAt: release.staging_lock_at,
      prCount: prCount?.count || 0,
      currentPhase,
      totalPhases,
      planId: release.plan_id,
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

    // Also query paused tasks for visibility
    const paused = db.prepare(
      "SELECT id, title FROM persistent_tasks WHERE status = 'paused'"
    ).all();
    const pausedTasks = [];
    for (const task of paused) {
      let pauseReason = 'unknown';
      try {
        const evt = db.prepare(
          "SELECT details FROM events WHERE persistent_task_id = ? AND event_type = 'paused' ORDER BY created_at DESC LIMIT 1"
        ).get(task.id);
        if (evt?.details) {
          const d = JSON.parse(evt.details);
          pauseReason = d.reason === 'crash_loop_circuit_breaker' ? 'crash-loop'
            : d.reason === 'cto_bypass_request' ? 'bypass-request'
            : 'manual';
        }
      } catch { /* non-fatal */ }
      pausedTasks.push({ title: task.title, pauseReason });
    }

    db.close();

    if (result.length === 0 && pausedTasks.length === 0) return null;

    return { tasks: result, monitorsAlive, monitorsDead, pausedTasks };
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
              "SELECT id, title, section, category_id, priority, description FROM tasks WHERE id = ?"
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
      "SELECT id, title, section, category_id, priority, description FROM tasks WHERE status = 'in_progress' ORDER BY started_at DESC LIMIT 1"
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

  // Local mode notice
  const localMode = getLocalModeState();
  if (localMode) {
    lines.push('[LOCAL MODE] Remote servers excluded. Local tooling only. Run /local-mode to disable.');
    lines.push('');
  }

  // Logging health (one-line status)
  if (!localMode) {
    try {
      const servicesPath = path.join(PROJECT_DIR, '.claude', 'config', 'services.json');
      if (fs.existsSync(servicesPath)) {
        const svcConfig = JSON.parse(fs.readFileSync(servicesPath, 'utf-8'));
        const elastic = svcConfig?.elastic;
        const hasLocalCreds = svcConfig?.secrets?.local?.ELASTIC_API_KEY && (svcConfig?.secrets?.local?.ELASTIC_CLOUD_ID || svcConfig?.secrets?.local?.ELASTIC_ENDPOINT);
        if (elastic && elastic.enabled !== false) {
          const prefix = elastic.indexPrefix || 'logs';
          lines.push(`Logging: Elastic Cloud enabled | Index: ${prefix}-{service}-{date} | Local creds: ${hasLocalCreds ? 'configured' : 'MISSING — run populate_secrets_local'}`);
        } else if (!elastic) {
          lines.push('Logging: Elastic Cloud not configured (add elastic section via update_services_config)');
        } else {
          lines.push('Logging: Elastic Cloud disabled');
        }
        lines.push('');
      }
    } catch { /* non-fatal */ }
  }

  // Active production release (high-priority — shown before queue)
  const activeRelease = getActiveRelease();
  if (activeRelease) {
    const phaseNum = parseInt(activeRelease.currentPhase, 10);
    if (phaseNum >= 7) {
      // CTO sign-off required — prominent action block
      lines.push('=== CTO SIGN-OFF REQUIRED ===');
      lines.push(`Release ${activeRelease.id} (v${activeRelease.version}) is ready for your approval.`);
      lines.push('');
      lines.push('To review and approve:');
      lines.push(`  1. mcp__release-ledger__present_release_summary({ release_id: "${activeRelease.id}" })`);
      lines.push('  2. Review the report and artifacts (open the artifact directory)');
      lines.push('  3. State your approval (e.g., "Approved for production")');
      lines.push(`  4. mcp__release-ledger__record_cto_approval({ release_id: "${activeRelease.id}", approval_text: "<your exact approval text>" })`);
      lines.push('');
    } else {
      lines.push('=== ACTIVE PRODUCTION RELEASE ===');
      lines.push(`Release: ${activeRelease.id} (v${activeRelease.version})`);
      lines.push(`Status: Phase ${activeRelease.currentPhase} of ${activeRelease.totalPhases}`);
      if (activeRelease.stagingLockAt) {
        lines.push(`Staging: LOCKED since ${activeRelease.stagingLockAt}`);
      }
      lines.push(`PRs: ${activeRelease.prCount}`);
      lines.push('Monitor: /plan-progress or /monitor');
      lines.push('');
    }
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

  // Preview → Staging drift
  const drift = getPreviewStagingDrift();
  if (drift && drift.count > 0) {
    lines.push('=== PREVIEW → STAGING ===');
    let driftLine = `${drift.count} commit${drift.count === 1 ? '' : 's'} on preview not yet in staging`;
    if (drift.ageHours !== null) {
      driftLine += ` (oldest: ${drift.ageHours}h ago)`;
    }

    // Check staging lock
    try {
      const lockPath = path.join(PROJECT_DIR, '.claude', 'state', 'staging-lock.json');
      if (fs.existsSync(lockPath)) {
        const lockState = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        if (lockState.locked) {
          driftLine += ' (staging locked — promotion paused for prod release)';
        }
      }
    } catch { /* non-fatal */ }

    // Check automation toggle
    try {
      const configPath = path.join(PROJECT_DIR, '.claude', 'autonomous-mode.json');
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (config.previewPromotionEnabled === false) {
          driftLine += ' (automated promotion disabled)';
        }
      }
    } catch { /* non-fatal */ }

    lines.push(driftLine);
    lines.push('');
  }

  // DORA metrics
  try {
    const autoStatePath = path.join(PROJECT_DIR, '.claude', 'state', 'hourly-automation-state.json');
    if (fs.existsSync(autoStatePath)) {
      const autoState = JSON.parse(fs.readFileSync(autoStatePath, 'utf8'));
      if (autoState.latestDoraMetrics) {
        const m = autoState.latestDoraMetrics;
        const parts = [];
        if (m.deployment_frequency != null) parts.push(`freq ${m.deployment_frequency}/day`);
        if (m.lead_time_hours != null) parts.push(`lead ${m.lead_time_hours}h`);
        if (m.change_failure_rate != null) parts.push(`CFR ${m.change_failure_rate}%`);
        if (m.mttr_minutes != null) parts.push(`MTTR ${m.mttr_minutes}m`);
        if (parts.length > 0) {
          lines.push(`DORA: ${(m.rating || 'N/A').toUpperCase()} (${parts.join(', ')})`);
        }
      }
    }
  } catch { /* non-fatal */ }

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

  // Active test scope
  try {
    const cfgPath = path.join(PROJECT_DIR, '.claude', 'config', 'services.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const scopeName = process.env.GENTYR_TEST_SCOPE || cfg.activeTestScope;
      if (scopeName && cfg.testScopes?.[scopeName]) {
        const s = cfg.testScopes[scopeName];
        lines.push(`Test Scope: "${scopeName}"${s.description ? ` — ${s.description}` : ''} (only scoped failures block push/promotion)`);
      }
    }
  } catch { /* non-fatal */ }

  // Active Persona Profile
  try {
    const activeProfilePath = path.join(PROJECT_DIR, '.claude', 'state', 'persona-profiles', 'active-profile.json');
    if (fs.existsSync(activeProfilePath)) {
      const activeProfile = JSON.parse(fs.readFileSync(activeProfilePath, 'utf8'));
      if (activeProfile?.name) {
        let profileInfo = `Persona Profile: "${activeProfile.name}"`;
        try {
          const profileMeta = JSON.parse(fs.readFileSync(
            path.join(PROJECT_DIR, '.claude', 'state', 'persona-profiles', activeProfile.name, 'profile.json'), 'utf8'));
          if (profileMeta?.description) profileInfo += ` — ${profileMeta.description}`;
          if (profileMeta?.guiding_prompt) {
            const prompt = profileMeta.guiding_prompt.length > 120
              ? profileMeta.guiding_prompt.substring(0, 120) + '...'
              : profileMeta.guiding_prompt;
            profileInfo += `\n  Guiding prompt: ${prompt}`;
          }
        } catch { /* non-fatal */ }
        lines.push(profileInfo);
      }
    }
  } catch { /* non-fatal */ }

  // Blocking Queue (work-stopping items — shown above bypass requests)
  const blockingItems = getBlockingQueue();
  if (blockingItems) {
    lines.push('');
    lines.push('=== WORK BLOCKED — CTO ACTION REQUIRED ===');
    for (let i = 0; i < blockingItems.length; i++) {
      const item = blockingItems[i];
      const ago = timeAgoStr(item.created_at);
      const levelLabel = item.blocking_level === 'plan' ? 'PLAN BLOCKED' :
                         item.blocking_level === 'persistent_task' ? 'TASK BLOCKED' : 'BLOCKED';
      const planCtx = item.plan_title ? ` in plan "${truncate(item.plan_title, 40)}"` : '';
      lines.push(`[${i + 1}] ${levelLabel}${planCtx} — ${ago}`);
      lines.push(`    ${truncate(item.summary, 120)}`);
      // Parse impact assessment if available
      if (item.impact_assessment) {
        try {
          const impact = JSON.parse(item.impact_assessment);
          const parts = [];
          if (impact.blocked_tasks?.length > 0) parts.push(`${impact.blocked_tasks.length} downstream task(s) blocked`);
          if (impact.is_gate) parts.push('gate phase');
          if (!impact.parallel_paths_available) parts.push('no parallel work');
          if (parts.length > 0) lines.push(`    Impact: ${parts.join(', ')}`);
        } catch (_) { /* non-fatal */ }
      }
      if (item.bypass_request_id) {
        lines.push(`    → mcp__agent-tracker__resolve_bypass_request({ request_id: "${item.bypass_request_id}", decision: "approved"|"rejected", context: "..." })`);
      }
    }
  }

  // CTO Bypass Requests
  const bypassRequests = getPendingBypassRequests();
  if (bypassRequests) {
    lines.push('');
    lines.push('=== CTO BYPASS REQUESTS AWAITING DECISION ===');
    for (let i = 0; i < bypassRequests.length; i++) {
      const req = bypassRequests[i];
      const ago = timeAgoStr(req.created_at);
      lines.push(`[${i + 1}] "${truncate(req.task_title, 50)}" (${req.task_type}, ${req.category}) — ${ago}`);
      lines.push(`    ${truncate(req.summary, 120)}`);
      lines.push(`    → mcp__agent-tracker__resolve_bypass_request({ request_id: "${req.id}", decision: "approved"|"rejected", context: "..." })`);
    }
  }

  // Deferred Protected Actions
  const deferredActions = getPendingDeferredActions();
  if (deferredActions) {
    lines.push('');
    lines.push('=== DEFERRED PROTECTED ACTIONS AWAITING APPROVAL ===');
    for (let i = 0; i < deferredActions.length; i++) {
      const act = deferredActions[i];
      const ago = timeAgoStr(act.created_at);
      let argsSummary = '';
      try {
        const args = typeof act.args === 'string' ? JSON.parse(act.args) : act.args;
        const keys = Object.keys(args);
        argsSummary = keys.length > 0 ? ` (${keys.slice(0, 3).join(', ')}${keys.length > 3 ? '...' : ''})` : '';
      } catch { /* non-fatal */ }
      lines.push(`[${i + 1}] ${act.server}:${act.tool}${argsSummary} — ${ago}`);
      lines.push(`    To approve: ${act.phrase} ${act.code}`);
      if (act.requester_agent_id) {
        lines.push(`    Requested by: ${act.requester_agent_id}`);
      }
    }
    lines.push('    Approved actions execute automatically via MCP daemon.');
  }

  // Persistent tasks
  const ptState = getPersistentTaskState();
  if (ptState) {
    if (ptState.tasks.length > 0) {
      lines.push(`PERSISTENT TASKS: ${ptState.tasks.length} active | ${ptState.monitorsAlive} monitor(s) alive${ptState.monitorsDead > 0 ? `, ${ptState.monitorsDead} DEAD` : ''}`);
      for (const t of ptState.tasks) {
        const monStatus = t.monitorAlive ? 'running' : 'DEAD';
        const amendStr = t.pendingAmendments > 0 ? `, ${t.pendingAmendments} pending amendment(s)` : '';
        lines.push(`  "${truncate(t.title, 50)}" — monitor ${monStatus}${amendStr}`);
      }
    }
    if (ptState.pausedTasks && ptState.pausedTasks.length > 0) {
      const crashLoop = ptState.pausedTasks.filter(t => t.pauseReason === 'crash-loop').length;
      const bypassReq = ptState.pausedTasks.filter(t => t.pauseReason === 'bypass-request').length;
      const manual = ptState.pausedTasks.length - crashLoop - bypassReq;
      const summary = [crashLoop > 0 && `${crashLoop} crash-loop`, bypassReq > 0 && `${bypassReq} bypass-request`, manual > 0 && `${manual} manual`].filter(Boolean).join(', ');
      lines.push(`PAUSED TASKS: ${ptState.pausedTasks.length} (${summary})`);
      for (const t of ptState.pausedTasks) {
        lines.push(`  "${truncate(t.title, 50)}" — ${t.pauseReason} paused`);
      }
    }
  }

  // Work orchestration decision guidance
  lines.push('');
  lines.push('WORK ORCHESTRATION (MANDATORY): Before creating work items, present orchestration analysis to the CTO:');
  lines.push('  1. Scope: how many independent sub-problems? Sequential or parallelizable?');
  lines.push('  2. Tool choice + reasoning (2-3 sentences)');
  lines.push('  3. Parallelization: splitting or bundling, and why');
  lines.push('  Decision matrix:');
  lines.push('    3+ independent items → parallel tasks (separate create_task for each, force_spawn_tasks all at once)');
  lines.push('    Multi-phase with dependencies → /plan (structured phases, plan manager auto-spawns)');
  lines.push('    Complex multi-session objective → /persistent-task (sustained monitoring, child sessions)');
  lines.push('    Single focused problem → single task or just do it directly');

  lines.push('');
  lines.push('Hint: Use mcp__agent-tracker__peek_session to drill into any session.');
  lines.push('      Use mcp__agent-tracker__send_session_signal to communicate with agents.');
  lines.push('      Use mcp__show__show_session-queue for the full queue widget.');

  return lines.join('\n');
}

function buildSpawnedBriefing() {
  const lines = ['[SESSION BRIEFING \u2014 MANDATORY PRE-WORK PROTOCOL]', ''];

  // Local mode notice
  const localMode = getLocalModeState();
  if (localMode) {
    lines.push('[LOCAL MODE] Remote servers excluded. Local tooling only. Run /local-mode to disable.');
    lines.push('');
  }

  // Task context
  const task = getCurrentTaskDetails();
  if (task) {
    lines.push(`You are starting work on: "${truncate(task.title, 80)}"`);
    lines.push(`Task ID: ${task.id} | Category: ${task.category_id || task.section} | Priority: ${task.priority}`);
  } else {
    lines.push('You are starting a new work session.');
  }

  // Active test scope (awareness for spawned agents)
  try {
    const cfgPath = path.join(PROJECT_DIR, '.claude', 'config', 'services.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const scopeName = process.env.GENTYR_TEST_SCOPE || cfg.activeTestScope;
      if (scopeName && cfg.testScopes?.[scopeName]) {
        lines.push(`Active test scope: "${scopeName}" — only scoped test failures block deployment`);
      }
    }
  } catch { /* non-fatal */ }

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

  // Worktree filesystem layout — prevent agents from misdiagnosing symlinks as circular
  if (process.env.CLAUDE_WORKTREE_DIR) {
    lines.push('');
    lines.push('WORKTREE FILESYSTEM LAYOUT:');
    lines.push(`  Main tree (PROJECT_DIR): ${PROJECT_DIR}`);
    lines.push(`  Your worktree (CWD):     ${process.env.CLAUDE_WORKTREE_DIR}`);
    lines.push('  Symlinked dirs: .claude/config, .claude/hooks, .claude/commands, .claude/mcp');
    lines.push('  These symlinks point to the main tree — this is NORMAL, not circular.');
    lines.push('  When diagnosing filesystem errors, check the main tree target, not the symlink itself.');
  }

  // Worktree artifact copy status
  if (process.env.CLAUDE_WORKTREE_DIR) {
    try {
      const configPath = path.join(PROJECT_DIR, '.claude', 'config', 'services.json');
      if (fs.existsSync(configPath)) {
        const svcConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (!svcConfig.worktreeArtifactCopy || svcConfig.worktreeArtifactCopy.length === 0) {
          if (svcConfig.worktreeBuildCommand) {
            lines.push('');
            lines.push('HINT: worktreeArtifactCopy is not configured. Worktrees run a full build on each provision.');
            lines.push('  Configure via: update_services_config({ updates: { worktreeArtifactCopy: ["packages/*/dist"] } })');
          }
        }
      }
    } catch { /* non-fatal */ }
  }

  // Worktree freshness check
  if (process.env.CLAUDE_WORKTREE_DIR) {
    try {
      // Detect base branch
      let baseBranch = 'main';
      try {
        execFileSync('git', ['rev-parse', '--verify', 'origin/preview'], {
          cwd: PROJECT_DIR, encoding: 'utf8', timeout: 5000, stdio: 'pipe',
        });
        baseBranch = 'preview';
      } catch { /* no preview branch */ }

      const behindStr = execFileSync(
        'git', ['rev-list', `HEAD..origin/${baseBranch}`, '--count'],
        { cwd: process.env.CLAUDE_WORKTREE_DIR, encoding: 'utf8', timeout: 5000, stdio: 'pipe' },
      ).trim();
      const behind = parseInt(behindStr, 10) || 0;

      lines.push('');
      if (behind > 0) {
        lines.push(`WORKTREE STALE: ${behind} commit(s) behind origin/${baseBranch}. Run: git fetch origin && git merge origin/${baseBranch} --no-edit`);
      } else {
        lines.push(`Worktree is up to date with origin/${baseBranch}`);
      }
    } catch {
      // Non-fatal — freshness check shouldn't block session start
    }
  }

  // Tool changelog — notify about new GENTYR MCP tools
  try {
    const changelogPath = path.join(PROJECT_DIR, '.claude', 'state', 'mcp-tool-changelog.json');
    if (fs.existsSync(changelogPath)) {
      const changelog = JSON.parse(fs.readFileSync(changelogPath, 'utf-8'));
      const age = Date.now() - new Date(changelog.timestamp).getTime();
      if (age < 24 * 60 * 60 * 1000) { // < 24h old
        const newTools = changelog.newTools || [];
        if (newTools.length > 0) {
          lines.push('');
          lines.push('NEW GENTYR TOOLS AVAILABLE (added in recent framework update):');
          for (const t of newTools.slice(0, 10)) {
            lines.push(`  - ${t.name} (${t.server}): ${truncate(t.description, 100)}`);
          }
          lines.push('Check if any of these are relevant to your current task.');
        }
      }
    }
  } catch { /* non-fatal */ }

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
