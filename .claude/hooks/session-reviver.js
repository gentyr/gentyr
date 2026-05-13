#!/usr/bin/env node
/**
 * Session Reviver - Recovers crashed automated sessions
 *
 * Called from hourly-automation.js every automation cycle. One mode:
 *
 * Mode 2 - Historical dead session recovery:
 *   Scans agent-tracker-history.json for agents that died unexpectedly
 *   (process_already_dead) within last 7 days. Cross-references with TODO db
 *   to find pending tasks that should be re-spawned.
 *
 * @version 2.0.0
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { AGENT_TYPES, HOOK_TYPES, registerHookExecution, acquireLock, releaseLock } from './agent-tracker.js';
import { shouldAllowSpawn } from './lib/memory-pressure.js';
import { enqueueSession } from './lib/session-queue.js';
import { auditEvent } from './lib/session-audit.js';
import { checkBypassBlock } from './lib/bypass-guard.js';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_DIR = path.join(PROJECT_DIR, '.claude', 'state');
const HISTORY_PATH = path.join(STATE_DIR, 'agent-tracker-history.json');
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// Limits
const MAX_REVIVALS_PER_CYCLE = 3;
const DEAD_SESSION_MAX_AGE_DAYS = 7;

// Lazy SQLite
let Database = null;
try {
  Database = (await import('better-sqlite3')).default;
} catch (err) {
  console.error('[session-reviver] Warning:', err.message);
  // Non-fatal
}

// ============================================================================
// Suspended Session Check
// ============================================================================

/**
 * Check if a session or agent is currently suspended in the queue (preempted by CTO task).
 * Suspended sessions will be re-enqueued automatically and should not be revived separately.
 *
 * @param {string} [sessionId] - Session UUID to check
 * @param {string} [agentId] - Agent ID to check
 * @returns {boolean} true if this session/agent is suspended
 */
function isSessionSuspended(sessionId, agentId) {
  if (!Database) return false;

  const queueDbPath = path.join(STATE_DIR, 'session-queue.db');
  if (!fs.existsSync(queueDbPath)) return false;

  let db;
  try {
    db = new Database(queueDbPath, { readonly: true });

    if (agentId) {
      const row = db.prepare(
        "SELECT id FROM queue_items WHERE status = 'suspended' AND agent_id = ?"
      ).get(agentId);
      if (row) return true;
    }

    if (sessionId) {
      // Check resume_session_id — suspended items have their original session referenced in
      // the re-enqueued resume item, but the suspended item itself is identified by agent_id.
      // Also check metadata for originalSessionId.
      const rows = db.prepare(
        "SELECT metadata FROM queue_items WHERE status = 'suspended'"
      ).all();
      for (const row of rows) {
        try {
          const meta = JSON.parse(row.metadata || '{}');
          if (meta.originalSessionId === sessionId) return true;
        } catch (err) {
          console.error('[session-reviver] Warning: metadata parse error in suspended check:', err.message);
        }
      }
    }

    return false;
  } catch (err) {
    console.error('[session-reviver] Warning: isSessionSuspended error:', err.message);
    return false; // Fail open — don't block revival on error
  } finally {
    if (db) {
      try { db.close(); } catch (_) { /* cleanup - failure expected */}
    }
  }
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
    process_already_dead: 'unexpected process death',
  }[reason] || reason;

  let prompt = `[SESSION REVIVED] This session was interrupted ${elapsed} ago due to ${reasonText} and is now being resumed.\n\n`;
  prompt += `IMPORTANT: Before continuing any work, you MUST first verify that your assigned task has not already been completed by another agent while you were interrupted. `;

  if (taskId) {
    prompt += `Check the status of task ${taskId} using mcp__todo-db__get_task. `;
    prompt += `If the task status is 'completed', report that it was already handled and exit immediately. `;
    prompt += `If the task is still 'pending' or 'in_progress', proceed with the work where you left off.`;
  } else {
    prompt += `Check mcp__todo-db__list_tasks for your category to see if your work has been completed. `;
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
  } catch (err) {
    console.error('[session-reviver] Warning:', err.message);
    return null;
  }
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
  } catch (err) {
    console.error('[session-reviver] Warning:', err.message);
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
  } catch (err) {
    console.error('[session-reviver] Warning:', err.message);
    return null;
  }

  for (const file of files) {
    const filePath = path.join(sessionDir, file);
    let fd;
    try {
      fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(65536);
      const bytesRead = fs.readSync(fd, buf, 0, 65536, 0);
      if (buf.toString('utf8', 0, bytesRead).includes(marker)) return filePath;
    } catch (err) {
      console.error('[session-reviver] Warning:', err.message);
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
  } catch (err) {
    console.error('[session-reviver] Warning:', err.message);
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
  } catch (err) {
    console.error('[session-reviver] Warning:', err.message);
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

      // Skip agents that are suspended (preempted by CTO task) — they will resume via the queue
      if (isSessionSuspended(null, agent.id)) {
        log(`  Dead agent ${agent.id} is suspended in queue (preempted), skipping revival.`);
        continue;
      }

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
        } catch (_) { /* cleanup - failure expected */ /* non-fatal */ }
      }

      // Check if TODO is pending or in_progress (reaper may have reset it, or it may still be in_progress
      // if the reaper ran but couldn't find the session file to complete reconciliation)
      const task = db.prepare('SELECT id, status FROM tasks WHERE id = ? AND status IN (?, ?)').get(taskId, 'pending', 'in_progress');
      if (!task) continue;

      // Bypass request guard — skip tasks with pending CTO bypass requests
      try {
        const bypassCheck = checkBypassBlock('todo', taskId);
        if (bypassCheck.blocked) {
          log(`  Dead session for task ${taskId} has pending CTO bypass request — skipping revival.`);
          continue;
        }
      } catch (_) { /* non-fatal — fail open */ }

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
        try { auditEvent('session_revival_triggered', { source: 'session-reviver', reason: 'process_already_dead', original_agent_id: agent.id }); } catch (err) {
          console.error('[session-reviver] Warning:', err.message);
        }
        // Mark task back to in_progress
        try {
          const writeDb = new Database(todoDbPath);
          const now = new Date();
          writeDb.prepare("UPDATE tasks SET status = 'in_progress', started_at = ?, started_timestamp = ? WHERE id = ?")
            .run(now.toISOString(), Math.floor(now.getTime() / 1000), taskId);
          writeDb.close();
        } catch (_) { /* cleanup - failure expected */ /* non-fatal */ }
      }
    }
  } finally {
    if (historyDirty) {
      try {
        fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2), 'utf8');
      } catch (_) { /* cleanup - failure expected */ /* non-fatal */ }
    }
    if (locked) releaseLock();
    db.close();
  }

  return revived;
}

// ============================================================================
// Main entry point (called from hourly-automation.js)
// ============================================================================

/**
 * Revive crashed sessions. Called from hourly-automation.js.
 *
 * @param {function} log - Log function
 * @param {number} [maxConcurrent=5] - Maximum concurrent agents
 * @returns {Promise<{revivedDead: number}>}
 */
export async function reviveInterruptedSessions(log, maxConcurrent = 5) {
  const startTime = Date.now();
  const result = { revivedDead: 0 };

  // Check concurrency before reviving anything
  const running = countRunningAgents();
  const availableSlots = Math.max(0, maxConcurrent - running);

  if (availableSlots === 0) {
    log('Session reviver: no available slots, skipping.');
    return result;
  }

  const remainingSlots = Math.min(availableSlots, MAX_REVIVALS_PER_CYCLE);

  // Mode 2: Dead sessions with pending TODOs
  result.revivedDead = reviveDeadSessions(log, remainingSlots);

  registerHookExecution({
    hookType: HOOK_TYPES.SESSION_REVIVER,
    status: result.revivedDead > 0 ? 'success' : 'skipped',
    durationMs: Date.now() - startTime,
    metadata: result,
  });

  return result;
}
