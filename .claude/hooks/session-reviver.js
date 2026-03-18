#!/usr/bin/env node
/**
 * Session Reviver - Recovers interrupted automated sessions
 *
 * Called from hourly-automation.js every automation cycle. Three modes:
 *
 * Mode 1 - Quota-interrupted session pickup:
 *   Reads .claude/state/quota-interrupted-sessions.json written by stop-continue-hook.
 *   Re-spawns sessions with --resume if credentials have been rotated.
 *
 * Mode 2 - Historical dead session recovery:
 *   Scans agent-tracker-history.json for agents that died unexpectedly
 *   (process_already_dead) within last 7 days. Cross-references with TODO db
 *   to find pending tasks that should be re-spawned.
 *
 * Mode 3 - Paused session resume:
 *   Reads .claude/state/paused-sessions.json written by quota-monitor when all
 *   accounts are exhausted. Checks if any account has recovered.
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { AGENT_TYPES, HOOK_TYPES, registerHookExecution, acquireLock, releaseLock } from './agent-tracker.js';
import {
  readRotationState,
  writeRotationState,
  logRotationEvent,
  updateActiveCredentials,
  checkKeyHealth,
  selectActiveKey,
} from './key-sync.js';
import { shouldAllowSpawn } from './lib/memory-pressure.js';
import { enqueueSession } from './lib/session-queue.js';
import { auditEvent } from './lib/session-audit.js';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_DIR = path.join(PROJECT_DIR, '.claude', 'state');
const QUOTA_INTERRUPTED_PATH = path.join(STATE_DIR, 'quota-interrupted-sessions.json');
const PAUSED_SESSIONS_PATH = path.join(STATE_DIR, 'paused-sessions.json');
const HISTORY_PATH = path.join(STATE_DIR, 'agent-tracker-history.json');
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// Limits
const MAX_REVIVALS_PER_CYCLE = 3;
const DEAD_SESSION_MAX_AGE_DAYS = 7;
const RETROACTIVE_WINDOW_MS = 12 * 60 * 60 * 1000;
// 12h window: sessions interrupted during laptop sleep > 30min were being
// discarded. Match RETROACTIVE_WINDOW_MS since the stop hook already cleans
// entries older than 12h.
const NORMAL_STALE_WINDOW_MS = 12 * 60 * 60 * 1000;

// Lazy SQLite
let Database = null;
try {
  Database = (await import('better-sqlite3')).default;
} catch {
  // Non-fatal
}

/**
 * Check if a process is alive.
 * @param {number} pid
 * @returns {boolean}
 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

/**
 * Build the context prompt injected when a session is resumed.
 * Tells the agent how long it was interrupted and to verify its task status.
 */
function buildRevivalPrompt({ reason, interruptedAt, taskId }) {
  const elapsedMs = Date.now() - new Date(interruptedAt).getTime();
  const hours = Math.floor(elapsedMs / (60 * 60 * 1000));
  const minutes = Math.floor((elapsedMs % (60 * 60 * 1000)) / (60 * 1000));
  const elapsed = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

  const reasonText = {
    quota_interrupted: 'API quota exhaustion',
    process_already_dead: 'unexpected process death',
    account_recovered: 'all API accounts were exhausted',
  }[reason] || reason;

  let prompt = `[SESSION REVIVED] This session was interrupted ${elapsed} ago due to ${reasonText} and is now being resumed.\n\n`;
  prompt += `IMPORTANT: Before continuing any work, you MUST first verify that your assigned task has not already been completed by another agent while you were interrupted. `;

  if (taskId) {
    prompt += `Check the status of task ${taskId} using mcp__todo-db__get_task. `;
    prompt += `If the task status is 'completed', report that it was already handled and exit immediately. `;
    prompt += `If the task is still 'pending' or 'in_progress', proceed with the work where you left off.`;
  } else {
    prompt += `Check mcp__todo-db__list_tasks for your section to see if your work has been completed. `;
    prompt += `If it has, exit immediately. Otherwise, proceed where you left off.`;
  }

  return prompt;
}

/**
 * Resolve taskId for an agentId by scanning agent-tracker history.
 */
function resolveTaskIdForAgent(agentId) {
  if (!agentId) return null;
  try {
    if (!fs.existsSync(HISTORY_PATH)) return null;
    const history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    if (!Array.isArray(history.agents)) return null;
    const agent = history.agents.find(a => a.id === agentId);
    return agent?.metadata?.taskId || null;
  } catch { return null; }
}

/**
 * Count running automation agents.
 */
function countRunningAgents() {
  try {
    const result = execSync(
      "pgrep -f 'claude.*--dangerously-skip-permissions' 2>/dev/null | wc -l",
      { encoding: 'utf8', timeout: 5000, stdio: 'pipe' }
    ).trim();
    return parseInt(result, 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Discover the session directory for a project.
 */
function getSessionDir(projectDir) {
  const projectPath = projectDir.replace(/[^a-zA-Z0-9]/g, '-');
  const sessionDir = path.join(CLAUDE_PROJECTS_DIR, projectPath);
  if (fs.existsSync(sessionDir)) return sessionDir;

  const altPath = path.join(CLAUDE_PROJECTS_DIR, projectPath.replace(/^-/, ''));
  if (fs.existsSync(altPath)) return altPath;

  return null;
}

/**
 * Extract session ID from a JSONL transcript path.
 */
function extractSessionIdFromPath(transcriptPath) {
  if (!transcriptPath) return null;
  const basename = path.basename(transcriptPath, '.jsonl');
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  return uuidRegex.test(basename) ? basename : null;
}

/**
 * Find session file by agent ID in the session directory.
 */
function findSessionFileByAgentId(sessionDir, agentId) {
  const marker = `[AGENT:${agentId}]`;
  let files;
  try {
    files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'));
  } catch {
    return null;
  }

  for (const file of files) {
    const filePath = path.join(sessionDir, file);
    let fd;
    try {
      fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(2000);
      const bytesRead = fs.readSync(fd, buf, 0, 2000, 0);
      const head = buf.toString('utf8', 0, bytesRead);
      if (head.includes(marker)) return filePath;
    } catch {
      // skip
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  return null;
}

/**
 * Enqueue a resumed claude session via session-queue.
 * Returns true if the item was spawned immediately (drained), false otherwise.
 */
function spawnResumedSession(sessionId, agentId, log, revivalPrompt, resumeCwd = null, agentType = AGENT_TYPES.SESSION_REVIVED, metadata = {}) {
  // Use original worktree CWD if it still exists, otherwise fall back to main project
  const effectiveCwd = (resumeCwd && fs.existsSync(resumeCwd)) ? resumeCwd : PROJECT_DIR;

  // If worktree was cleaned up, warn the agent
  let prompt = revivalPrompt;
  if (resumeCwd && !fs.existsSync(resumeCwd)) {
    prompt += '\n\nNOTE: Your original worktree has been cleaned up. You are running from the main project directory. Create a new worktree if you need to make changes.';
  }

  try {
    const result = enqueueSession({
      title: `Revival: ${sessionId.slice(0, 8)}`,
      agentType,
      hookType: HOOK_TYPES.SESSION_REVIVER,
      tagContext: 'session-revived',
      source: 'session-reviver',
      spawnType: 'resume',
      resumeSessionId: sessionId,
      lane: 'revival',
      priority: 'urgent',
      prompt,
      cwd: effectiveCwd,
      mcpConfig: path.join(effectiveCwd, '.mcp.json'),
      projectDir: PROJECT_DIR,
      worktreePath: (resumeCwd && fs.existsSync(resumeCwd)) ? resumeCwd : null,
      metadata,
    });

    const spawned = result.drained.spawned > 0;
    if (spawned) {
      log(`  Enqueued and spawned revival of session ${sessionId.slice(0, 8)}... (queueId: ${result.queueId})`);
    } else {
      log(`  Enqueued revival of session ${sessionId.slice(0, 8)}... (queueId: ${result.queueId}, at capacity)`);
    }
    return spawned;
  } catch (err) {
    log(`  Failed to enqueue revival of session ${sessionId.slice(0, 8)}...: ${err.message}`);
    return false;
  }
}

// ============================================================================
// Mode 1: Quota-interrupted sessions
// ============================================================================

function reviveQuotaInterruptedSessions(log, maxRevivals, staleWindowMs = NORMAL_STALE_WINDOW_MS) {
  let revived = 0;

  if (!fs.existsSync(QUOTA_INTERRUPTED_PATH)) return revived;

  let data;
  try {
    data = JSON.parse(fs.readFileSync(QUOTA_INTERRUPTED_PATH, 'utf8'));
    if (!Array.isArray(data.sessions)) return revived;
  } catch {
    return revived;
  }

  const remaining = [];

  for (const session of data.sessions) {
    if (revived >= maxRevivals) {
      remaining.push(session);
      continue;
    }

    if (session.status !== 'pending_revival') {
      remaining.push(session);
      continue;
    }

    // Check if older than the stale window
    const age = Date.now() - new Date(session.interruptedAt).getTime();
    if (age > staleWindowMs) {
      const windowLabel = staleWindowMs > 60 * 60 * 1000 ? `${Math.round(staleWindowMs / (60 * 60 * 1000))}h` : `${Math.round(staleWindowMs / 60000)}m`;
      log(`  Quota-interrupted session ${session.agentId || 'unknown'} is stale (${Math.round(age / 60000)}m old, window: ${windowLabel}), discarding.`);
      continue;
    }

    const sessionId = session.sessionId || extractSessionIdFromPath(session.transcriptPath);
    if (!sessionId) {
      log(`  Cannot determine session ID for ${session.agentId || 'unknown'}, skipping.`);
      continue;
    }

    const taskId = resolveTaskIdForAgent(session.agentId);
    const revivalPrompt = buildRevivalPrompt({
      reason: 'quota_interrupted',
      interruptedAt: session.interruptedAt,
      taskId,
    });

    if (spawnResumedSession(sessionId, session.agentId || 'unknown', log, revivalPrompt, session.worktreePath || null, AGENT_TYPES.SESSION_REVIVED, {
      originalAgentId: session.agentId,
      originalSessionId: sessionId,
      revivalReason: 'quota_interrupted',
    })) {
      revived++;
      session.status = 'revived';
      try { auditEvent('session_revival_triggered', { source: 'session-reviver', reason: 'quota_interrupted', original_agent_id: session.agentId }); } catch {}
    } else {
      remaining.push(session);
    }
  }

  // Write back remaining sessions
  try {
    fs.writeFileSync(QUOTA_INTERRUPTED_PATH, JSON.stringify({ sessions: remaining }, null, 2), 'utf8');
  } catch { /* non-fatal */ }

  return revived;
}

// ============================================================================
// Mode 2: Historical dead session recovery
// ============================================================================

function reviveDeadSessions(log, maxRevivals) {
  let revived = 0;
  if (!Database) return revived;

  // Memory pressure check — skip entire revival cycle if system is under pressure
  const memCheck = shouldAllowSpawn({ priority: 'normal', context: 'session-reviver' });
  if (!memCheck.allowed) {
    log(memCheck.reason);
    return revived;
  }
  if (memCheck.reason) log(memCheck.reason);

  // Phase 4d: Use advisory lock to prevent concurrent history mutations
  const locked = acquireLock();

  let history;
  try {
    if (!fs.existsSync(HISTORY_PATH)) {
      if (locked) releaseLock();
      return revived;
    }
    history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    if (!Array.isArray(history.agents)) {
      if (locked) releaseLock();
      return revived;
    }
  } catch {
    if (locked) releaseLock();
    return revived;
  }

  const todoDbPath = path.join(PROJECT_DIR, '.claude', 'todo.db');
  if (!fs.existsSync(todoDbPath)) {
    if (locked) releaseLock();
    return revived;
  }

  let db;
  try {
    db = new Database(todoDbPath, { readonly: true });
  } catch {
    if (locked) releaseLock();
    return revived;
  }

  const sessionDir = getSessionDir(PROJECT_DIR);
  if (!sessionDir) {
    db.close();
    if (locked) releaseLock();
    return revived;
  }

  const cutoff = Date.now() - DEAD_SESSION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

  let historyDirty = false;

  try {
    for (const agent of history.agents) {
      if (revived >= maxRevivals) break;

      // Phase 4b: Skip agents that were already attempted for revival
      if (agent.revivalAttempted) continue;

      // Also check "running" agents that are actually dead (inline reaping)
      const isActuallyDead = (agent.status === 'running' && agent.pid && !isProcessAlive(agent.pid));
      if (isActuallyDead) {
        agent.status = 'completed';
        agent.reapReason = 'process_already_dead';
        agent.reapedAt = new Date().toISOString();
        historyDirty = true;
      }
      const isDead = isActuallyDead ||
        (agent.status === 'completed' && agent.reapReason === 'process_already_dead') ||
        (agent.status === 'reaped' && agent.reapReason === 'process_already_dead');
      if (!isDead) continue;

      // Must have a task ID
      const taskId = agent.metadata?.taskId;
      if (!taskId) continue;

      // Must be recent enough
      const agentTime = new Date(agent.timestamp).getTime();
      if (agentTime < cutoff) continue;

      // For inline-reaped agents (detected here rather than by the reaper script),
      // reset the task to pending so the revival check below will find it.
      if (isActuallyDead && Database) {
        try {
          const resetDb = new Database(todoDbPath);
          const taskCheck = resetDb.prepare('SELECT id, status FROM tasks WHERE id = ?').get(taskId);
          if (taskCheck && taskCheck.status === 'in_progress') {
            resetDb.prepare("UPDATE tasks SET status = 'pending', started_at = NULL, started_timestamp = NULL WHERE id = ?").run(taskId);
          }
          resetDb.close();
        } catch { /* non-fatal */ }
      }

      // Check if TODO is pending or in_progress (reaper may have reset it, or it may still be in_progress
      // if the reaper ran but couldn't find the session file to complete reconciliation)
      const task = db.prepare('SELECT id, status FROM tasks WHERE id = ? AND status IN (?, ?)').get(taskId, 'pending', 'in_progress');
      if (!task) continue;

      // Find session file
      let sessionFile = agent.sessionFile;
      if (!sessionFile) {
        sessionFile = findSessionFileByAgentId(sessionDir, agent.id);
        // Try worktree session dir if not found
        if (!sessionFile && agent.metadata?.worktreePath) {
          const worktreeSessionDir = getSessionDir(agent.metadata.worktreePath);
          if (worktreeSessionDir) {
            sessionFile = findSessionFileByAgentId(worktreeSessionDir, agent.id);
          }
        }
      }
      if (!sessionFile) continue;

      const sessionId = extractSessionIdFromPath(sessionFile);
      if (!sessionId) continue;

      log(`  Found dead session for task ${taskId}: ${sessionId.slice(0, 8)}...`);

      const revivalPrompt = buildRevivalPrompt({
        reason: 'process_already_dead',
        interruptedAt: agent.timestamp,
        taskId,
      });

      // Phase 4b: Mark revival attempted regardless of outcome to prevent loops
      agent.revivalAttempted = true;
      historyDirty = true;

      if (spawnResumedSession(sessionId, agent.id, log, revivalPrompt, agent.metadata?.worktreePath || null, AGENT_TYPES.SESSION_REVIVED, {
        originalAgentId: agent.id,
        originalSessionId: sessionId,
        taskId,
        revivalReason: 'process_already_dead',
      })) {
        revived++;
        try { auditEvent('session_revival_triggered', { source: 'session-reviver', reason: 'process_already_dead', original_agent_id: agent.id }); } catch {}
        // Mark task back to in_progress
        try {
          const writeDb = new Database(todoDbPath);
          const now = new Date();
          writeDb.prepare("UPDATE tasks SET status = 'in_progress', started_at = ?, started_timestamp = ? WHERE id = ?")
            .run(now.toISOString(), Math.floor(now.getTime() / 1000), taskId);
          writeDb.close();
        } catch { /* non-fatal */ }
      }
    }
  } finally {
    if (historyDirty) {
      try {
        fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2), 'utf8');
      } catch { /* non-fatal */ }
    }
    if (locked) releaseLock();
    db.close();
  }

  return revived;
}

// ============================================================================
// Mode 3: Paused sessions (all accounts were exhausted)
// ============================================================================

async function resumePausedSessions(log, maxRevivals) {
  let revived = 0;

  if (!fs.existsSync(PAUSED_SESSIONS_PATH)) return revived;

  let data;
  try {
    data = JSON.parse(fs.readFileSync(PAUSED_SESSIONS_PATH, 'utf8'));
    if (!Array.isArray(data.sessions)) return revived;
  } catch {
    return revived;
  }

  if (data.sessions.length === 0) return revived;

  // Check if any key has recovered
  const state = readRotationState();
  let hasRecoveredKey = false;

  for (const [keyId, keyData] of Object.entries(state.keys)) {
    if (keyData.status === 'invalid' || keyData.status === 'expired' || keyData.status === 'tombstone' || keyData.status === 'merged') continue;

    const health = await checkKeyHealth(keyData.accessToken);
    if (health.valid && health.usage) {
      keyData.last_health_check = Date.now();
      keyData.last_usage = { ...health.usage, raw: health.raw, checked_at: Date.now() };

      const maxUsage = Math.max(health.usage.five_hour, health.usage.seven_day, health.usage.seven_day_sonnet);
      if (maxUsage < 90) {
        hasRecoveredKey = true;
        if (keyData.status === 'exhausted') {
          keyData.status = 'active';
        }
      }
    }
  }

  writeRotationState(state);

  if (!hasRecoveredKey) {
    log('  Paused sessions: all accounts still exhausted.');
    return revived;
  }

  // Rotate to the recovered key
  const selectedKeyId = selectActiveKey(state);
  if (selectedKeyId && selectedKeyId !== state.active_key_id) {
    state.active_key_id = selectedKeyId;
    state.keys[selectedKeyId].last_used_at = Date.now();
    logRotationEvent(state, {
      timestamp: Date.now(),
      event: 'key_switched',
      key_id: selectedKeyId,
      reason: 'session_reviver_account_recovered',
    });
    updateActiveCredentials(state.keys[selectedKeyId]);
    writeRotationState(state);
    log(`  Rotated to recovered account ${selectedKeyId.slice(0, 8)}...`);
  }

  const remaining = [];

  for (const session of data.sessions) {
    if (revived >= maxRevivals) {
      remaining.push(session);
      continue;
    }

    // Only revive automated sessions
    if (session.type !== 'automated') {
      // For interactive: just log that recovery is available
      if (session.type === 'interactive') {
        log(`  Interactive session can be resumed: run /restart-session`);
      }
      remaining.push(session);
      continue;
    }

    // Resolve sessionId: prefer explicit, fall back to agent-tracker lookup
    let sessionId = session.sessionId;
    if (!sessionId && session.agentId) {
      const sessionDir = getSessionDir(PROJECT_DIR);
      if (sessionDir) {
        const sessionFile = findSessionFileByAgentId(sessionDir, session.agentId);
        sessionId = extractSessionIdFromPath(sessionFile);
      }
    }
    if (!sessionId) {
      log(`  Cannot determine session ID for paused session ${session.agentId || 'unknown'}, skipping.`);
      continue;
    }

    const taskId = resolveTaskIdForAgent(session.agentId);
    const revivalPrompt = buildRevivalPrompt({
      reason: 'account_recovered',
      interruptedAt: new Date(session.pausedAt).toISOString(),
      taskId,
    });

    // Phase 4c: Pass worktreePath so resumed session runs in correct CWD
    if (spawnResumedSession(sessionId, session.agentId || 'unknown', log, revivalPrompt, session.worktreePath || null, AGENT_TYPES.SESSION_REVIVED, {
      originalAgentId: session.agentId,
      originalSessionId: sessionId,
      revivalReason: 'account_recovered',
    })) {
      revived++;
      try { auditEvent('session_revival_triggered', { source: 'session-reviver', reason: 'account_recovered', original_agent_id: session.agentId }); } catch {}
    } else {
      remaining.push(session);
    }
  }

  // Clean up entries older than 24h
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const filtered = remaining.filter(s => s.pausedAt > cutoff);

  try {
    fs.writeFileSync(PAUSED_SESSIONS_PATH, JSON.stringify({ sessions: filtered }, null, 2), 'utf8');
  } catch { /* non-fatal */ }

  return revived;
}

// ============================================================================
// Main entry point (called from hourly-automation.js)
// ============================================================================

/**
 * Revive interrupted sessions. Called from hourly-automation.js.
 *
 * @param {function} log - Log function
 * @param {number} [maxConcurrent=5] - Maximum concurrent agents
 * @returns {Promise<{revivedQuota: number, revivedDead: number, revivedPaused: number}>}
 */
export async function reviveInterruptedSessions(log, maxConcurrent = 5, options = {}) {
  const startTime = Date.now();
  const result = { revivedQuota: 0, revivedDead: 0, revivedPaused: 0 };

  // Check concurrency before reviving anything
  const running = countRunningAgents();
  const availableSlots = Math.max(0, maxConcurrent - running);

  if (availableSlots === 0) {
    log('Session reviver: no available slots, skipping.');
    return result;
  }

  let remainingSlots = Math.min(availableSlots, MAX_REVIVALS_PER_CYCLE);

  // Mode 1: Quota-interrupted sessions (highest priority)
  const staleWindowMs = options.retroactive ? RETROACTIVE_WINDOW_MS : NORMAL_STALE_WINDOW_MS;
  result.revivedQuota = reviveQuotaInterruptedSessions(log, remainingSlots, staleWindowMs);
  remainingSlots -= result.revivedQuota;

  // Mode 2: Dead sessions with pending TODOs
  if (remainingSlots > 0) {
    result.revivedDead = reviveDeadSessions(log, remainingSlots);
    remainingSlots -= result.revivedDead;
  }

  // Mode 3: Paused sessions (lowest priority - may need API checks)
  if (remainingSlots > 0) {
    result.revivedPaused = await resumePausedSessions(log, remainingSlots);
  }

  const totalRevived = result.revivedQuota + result.revivedDead + result.revivedPaused;

  registerHookExecution({
    hookType: HOOK_TYPES.SESSION_REVIVER,
    status: totalRevived > 0 ? 'success' : 'skipped',
    durationMs: Date.now() - startTime,
    metadata: result,
  });

  return result;
}
