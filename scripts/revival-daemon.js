#!/usr/bin/env node
/**
 * Revival Daemon - Sub-second crash recovery for agent processes
 *
 * Watches agent-tracker-history.json for changes and detects dead agents
 * within 500ms of their crash. Spawns `claude --resume` to revive them.
 *
 * This covers crashes where the Stop hook never fires (process kill, laptop
 * restart, OOM). The hourly-automation session reviver is the fallback.
 *
 * Runs as a launchd KeepAlive service alongside the hourly automation service.
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
// Enforce CWD — launchd WorkingDirectory is unreliable (macOS launchctl load/unload bug)
try { process.chdir(PROJECT_DIR); } catch { /* non-fatal */ }
const STATE_DIR = path.join(PROJECT_DIR, '.claude', 'state');
const HISTORY_PATH = path.join(STATE_DIR, 'agent-tracker-history.json');
const LOG_FILE = path.join(PROJECT_DIR, '.claude', 'revival-daemon.log');

// Debounce: wait 500ms after file change before scanning
const DEBOUNCE_MS = 500;
// Don't attempt revival for agents older than 1h
const MAX_AGENT_AGE_MS = 60 * 60 * 1000;
// Clear revival attempt tracking after 1h
const REVIVAL_TRACKING_TTL_MS = 60 * 60 * 1000;
// Scan interval when fs.watch is not available or unreliable
const POLL_INTERVAL_MS = 10000;

// Track which agents we've already attempted revival for
const revivalAttempted = new Map(); // agentId -> timestamp

// ============================================================================
// Suspended Session Check
// ============================================================================

/**
 * Check if an agent is currently suspended in the session queue (preempted by CTO task).
 * Suspended agents will be re-enqueued automatically via the preemption system.
 *
 * @param {string} agentId - Agent ID to check
 * @returns {boolean} true if this agent is suspended
 */
function isAgentSuspended(agentId) {
  if (!Database || !agentId) return false;

  const queueDbPath = path.join(STATE_DIR, 'session-queue.db');
  try {
    if (!fs.existsSync(queueDbPath)) return false;
    const db = new Database(queueDbPath, { readonly: true });
    try {
      const row = db.prepare(
        "SELECT id FROM queue_items WHERE status = 'suspended' AND agent_id = ?"
      ).get(agentId);
      return !!row;
    } finally {
      try { db.close(); } catch (_) { /* cleanup - failure expected */}
    }
  } catch (err) {
    // Fail open — do not block revival on DB errors
    return false;
  }
}

let debounceTimer = null;

// Lazy imports — loaded after PROJECT_DIR is set
let registerSpawn, updateAgent, AGENT_TYPES, HOOK_TYPES, acquireLock, releaseLock;
let buildRevivalPrompt, spawnResumedSession, getSessionDir, findSessionFileByAgentId, extractSessionIdFromPath, resolveTaskIdForAgent;
let shouldAllowSpawn;
let drainQueue;
let auditEvent;
let Database = null;

async function loadDependencies() {
  const agentTracker = await import(path.join(PROJECT_DIR, '.claude', 'hooks', 'agent-tracker.js'));
  registerSpawn = agentTracker.registerSpawn;
  updateAgent = agentTracker.updateAgent;
  AGENT_TYPES = agentTracker.AGENT_TYPES;
  HOOK_TYPES = agentTracker.HOOK_TYPES;
  acquireLock = agentTracker.acquireLock;
  releaseLock = agentTracker.releaseLock;

  const revivalUtils = await import(path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'revival-utils.js'));
  buildRevivalPrompt = revivalUtils.buildRevivalPrompt;
  spawnResumedSession = revivalUtils.spawnResumedSession;
  getSessionDir = revivalUtils.getSessionDir;
  findSessionFileByAgentId = revivalUtils.findSessionFileByAgentId;
  extractSessionIdFromPath = revivalUtils.extractSessionIdFromPath;
  resolveTaskIdForAgent = revivalUtils.resolveTaskIdForAgent;

  const memPressure = await import(path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'memory-pressure.js'));
  shouldAllowSpawn = memPressure.shouldAllowSpawn;

  const sessionQueue = await import(path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'session-queue.js'));
  drainQueue = sessionQueue.drainQueue;

  try {
    const sessionAudit = await import(path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'session-audit.js'));
    auditEvent = sessionAudit.auditEvent;
  } catch { /* non-fatal */ }

  try {
    Database = (await import('better-sqlite3')).default;
  } catch { /* non-fatal */ }
}

function log(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [revival-daemon] ${message}\n`;
  process.stderr.write(line);
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch { /* non-fatal */ }
}

/**
 * Check if a process is alive.
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
 * Clean up expired revival tracking entries.
 */
function cleanRevivalTracking() {
  const cutoff = Date.now() - REVIVAL_TRACKING_TTL_MS;
  for (const [agentId, timestamp] of revivalAttempted) {
    if (timestamp < cutoff) {
      revivalAttempted.delete(agentId);
    }
  }
}

/**
 * Main scan: find dead agents and revive them.
 */
function scanAndRevive() {
  cleanRevivalTracking();

  let history;
  const locked = acquireLock();
  try {
    if (!fs.existsSync(HISTORY_PATH)) {
      if (locked) releaseLock();
      return;
    }
    history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    if (!Array.isArray(history.agents)) {
      if (locked) releaseLock();
      return;
    }
  } catch {
    if (locked) releaseLock();
    return;
  }

  const now = Date.now();
  const cutoff = now - MAX_AGENT_AGE_MS;
  let historyDirty = false;
  let revived = 0;

  for (const agent of history.agents) {
    // Pick up memory-blocked agents for retry (they have status=completed + memoryBlocked=true)
    const isMemoryRetry = agent.status === 'completed' && agent.memoryBlocked && !agent.revivalAttempted;

    // Pick up cooldown-expired agents for retry (exhausted retries, cooldown period elapsed)
    const isCooldownRetry = agent.status === 'completed' && agent.revivalCooldownUntil
      && now >= agent.revivalCooldownUntil && !agent.revivalAttempted;
    if (isCooldownRetry) {
      // Cooldown expired — reset retries so the agent gets a fresh batch of attempts
      agent.revivalRetries = 0;
      agent.revivalCooldownUntil = null;
      agent.memoryBlocked = false;
      historyDirty = true;
    }

    // Normal path: check running agents with PIDs; OR retry blocked/cooldown agents
    if (!isMemoryRetry && !isCooldownRetry) {
      if (agent.status !== 'running' || !agent.pid) continue;
    }

    // Skip if permanently terminal (no taskId, task completed, no session file, etc.)
    if (revivalAttempted.has(agent.id)) continue;
    if (agent.revivalAttempted) continue;

    // Retry cap: after 5 attempts, enter escalating cooldown instead of permanent abandonment
    // Cooldown: 5 min → 10 min → 20 min → 30 min (capped)
    if ((agent.revivalRetries || 0) >= 5) {
      const cooldownCycle = agent.revivalCooldownCycle || 0;
      const cooldownMinutes = Math.min(5 * Math.pow(2, cooldownCycle), 30);
      agent.revivalCooldownUntil = now + cooldownMinutes * 60 * 1000;
      agent.revivalCooldownCycle = cooldownCycle + 1;
      historyDirty = true;
      log(`  Agent ${agent.id} exhausted 5 retries, entering ${cooldownMinutes}m cooldown (cycle ${cooldownCycle + 1})`);
      continue;
    }

    // Skip old agents
    const agentTime = new Date(agent.timestamp).getTime();
    if (agentTime < cutoff) continue;

    // Check if process is actually dead (skip for memory/cooldown retries — already confirmed dead)
    if (!isMemoryRetry && !isCooldownRetry && isProcessAlive(agent.pid)) continue;

    // Skip if this agent is suspended (preempted by a CTO task) — it will be re-enqueued automatically
    if (isAgentSuspended(agent.id)) {
      log(`Dead agent ${agent.id} is suspended in queue (preempted by CTO task), skipping revival`);
      if (auditEvent) {
        try { auditEvent('revival_skipped_suspended', { agent_id: agent.id }); } catch {}
      }
      continue;
    }

    // Dead agent found
    log(`Dead agent detected: ${agent.id} (PID ${agent.pid}, type: ${agent.type})`);
    if (auditEvent) {
      try { auditEvent('session_reaped_dead', { agent_id: agent.id, pid: agent.pid, source: 'revival-daemon' }); } catch {}
    }

    // Mark as dead in history (status/reapReason/reapedAt are always set regardless of revival outcome)
    agent.status = 'completed';
    agent.reapReason = 'process_already_dead';
    agent.reapedAt = new Date().toISOString();
    historyDirty = true;

    // Check memory pressure first — if blocked, DON'T mark revivalAttempted so we retry
    if (shouldAllowSpawn) {
      const memCheck = shouldAllowSpawn({ priority: 'normal', context: 'revival-daemon' });
      if (!memCheck.allowed) {
        log(`  ${memCheck.reason}`);
        log(`  Revival queued — will retry when memory pressure drops (next scan in ${POLL_INTERVAL_MS / 1000}s)`);
        agent.memoryBlocked = true;
        if (auditEvent) {
          try { auditEvent('revival_blocked_memory', { agent_id: agent.id }); } catch {}
        }
        continue;
      }
      if (memCheck.reason) log(`  ${memCheck.reason}`);
    }

    // Only count a retry when we actually attempt revival (not when blocked by memory/quota)
    agent.revivalRetries = (agent.revivalRetries || 0) + 1;

    // Find task ID
    const taskId = agent.metadata?.taskId;
    if (!taskId) {
      log(`  No taskId for agent ${agent.id}, skipping revival`);
      agent.revivalAttempted = true;
      revivalAttempted.set(agent.id, now);
      continue;
    }

    // Check if task still needs work
    if (Database) {
      try {
        const todoDbPath = path.join(PROJECT_DIR, '.claude', 'todo.db');
        if (fs.existsSync(todoDbPath)) {
          const db = new Database(todoDbPath, { readonly: true });
          const task = db.prepare('SELECT id, status FROM tasks WHERE id = ? AND status IN (?, ?)').get(taskId, 'pending', 'in_progress');
          db.close();
          if (!task) {
            log(`  Task ${taskId} already completed or missing, skipping revival`);
            agent.revivalAttempted = true;
            revivalAttempted.set(agent.id, now);
            continue;
          }
          // Reset in_progress tasks to pending so revival can re-claim
          if (task.status === 'in_progress') {
            const writeDb = new Database(todoDbPath);
            writeDb.prepare("UPDATE tasks SET status = 'pending', started_at = NULL, started_timestamp = NULL WHERE id = ?").run(taskId);
            writeDb.close();
            if (auditEvent) {
              try { auditEvent('task_reset_pre_revival', { agent_id: agent.id, task_id: taskId }); } catch {}
            }
          }
        }
      } catch { /* non-fatal */ }
    }

    // Find session file
    const sessionDir = getSessionDir(PROJECT_DIR);
    if (!sessionDir) {
      log(`  No session dir found, skipping revival`);
      agent.revivalAttempted = true;
      revivalAttempted.set(agent.id, now);
      continue;
    }

    let sessionFile = agent.sessionFile;
    if (!sessionFile) {
      sessionFile = findSessionFileByAgentId(sessionDir, agent.id);
      if (!sessionFile && agent.metadata?.worktreePath) {
        const worktreeSessionDir = getSessionDir(agent.metadata.worktreePath);
        if (worktreeSessionDir) {
          sessionFile = findSessionFileByAgentId(worktreeSessionDir, agent.id);
        }
      }
    }
    if (!sessionFile) {
      log(`  No session file found for agent ${agent.id}, skipping revival`);
      agent.revivalAttempted = true;
      revivalAttempted.set(agent.id, now);
      continue;
    }

    const sessionId = extractSessionIdFromPath(sessionFile);
    if (!sessionId) continue;

    // Spawn revival
    const newAgentId = registerSpawn({
      type: AGENT_TYPES.SESSION_REVIVED,
      hookType: HOOK_TYPES.SESSION_REVIVER,
      description: `Daemon revival of dead agent ${agent.id} for task ${taskId}`,
      prompt: `[revival-daemon, original agent: ${agent.id}]`,
      metadata: {
        originalAgentId: agent.id,
        originalSessionId: sessionId,
        taskId,
        revivalReason: 'daemon_crash_detection',
        worktreePath: agent.metadata?.worktreePath,
      },
    });

    const revivalPrompt = buildRevivalPrompt({
      reason: 'process_already_dead',
      interruptedAt: agent.timestamp,
      taskId,
    });

    if (spawnResumedSession(sessionId, newAgentId, log, revivalPrompt, agent.metadata?.worktreePath || null, { projectDir: PROJECT_DIR })) {
      agent.revivalAttempted = true;
      revivalAttempted.set(agent.id, now);
      revived++;
      if (auditEvent) {
        try { auditEvent('session_revival_triggered', { source: 'revival-daemon', agent_id: agent.id, new_agent_id: newAgentId, reason: 'daemon_crash_detection' }); } catch {}
      }
      // Mark task back to in_progress
      if (Database) {
        try {
          const todoDbPath = path.join(PROJECT_DIR, '.claude', 'todo.db');
          const writeDb = new Database(todoDbPath);
          const nowDate = new Date();
          writeDb.prepare("UPDATE tasks SET status = 'in_progress', started_at = ?, started_timestamp = ? WHERE id = ?")
            .run(nowDate.toISOString(), Math.floor(nowDate.getTime() / 1000), taskId);
          writeDb.close();
          if (auditEvent) {
            try { auditEvent('task_resumed_post_revival', { agent_id: newAgentId || agent.id, task_id: taskId }); } catch {}
          }
        } catch { /* non-fatal */ }
      }
      // Drain the session queue: other queued sessions may now fit under the concurrency limit
      if (drainQueue) {
        try {
          drainQueue();
        } catch { /* non-fatal */ }
      }
    } else {
      agent.revivalAttempted = true;
      revivalAttempted.set(agent.id, now);
      log(`  Revival spawn failed for ${agent.id}`);
    }
  }
  if (historyDirty) {
    try {
      fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2), 'utf8');
    } catch { /* non-fatal */ }
  }
  if (locked) releaseLock();

  if (revived > 0) {
    log(`Revived ${revived} dead agent(s)`);
  }

  // Always drain after scanning — even if no revival happened, dead PIDs freed slots.
  // reapSyncPass inside drainQueue() will mark dead queue items as completed,
  // then drain will spawn the next queued item immediately.
  if (drainQueue) {
    try { drainQueue(); } catch { /* non-fatal */ }
  }
}

/**
 * Debounced scan triggered by file change events.
 */
function debouncedScan() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    try {
      scanAndRevive();
    } catch (err) {
      log(`Scan error: ${err.message}`);
    }
  }, DEBOUNCE_MS);
}

async function main() {
  log('Revival daemon starting...');
  log(`PROJECT_DIR: ${PROJECT_DIR}`);
  log(`Watching: ${HISTORY_PATH}`);

  await loadDependencies();

  // Ensure state directory exists
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }

  // Initial scan on startup
  try {
    scanAndRevive();
  } catch (err) {
    log(`Initial scan error: ${err.message}`);
  }

  // Watch for changes to agent-tracker-history.json
  let watcher = null;
  try {
    watcher = fs.watch(HISTORY_PATH, { persistent: true }, (eventType) => {
      if (eventType === 'change') {
        debouncedScan();
      }
    });
    log('fs.watch active on history file');
  } catch {
    log('fs.watch unavailable, falling back to polling');
  }

  // Fallback poll (also catches cases where fs.watch misses events)
  setInterval(() => {
    try {
      scanAndRevive();
    } catch (err) {
      log(`Poll scan error: ${err.message}`);
    }
  }, POLL_INTERVAL_MS);

  // Handle graceful shutdown
  process.on('SIGTERM', () => {
    log('SIGTERM received, shutting down...');
    if (watcher) watcher.close();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    log('SIGINT received, shutting down...');
    if (watcher) watcher.close();
    process.exit(0);
  });

  log('Revival daemon ready');
}

main().catch(err => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});
