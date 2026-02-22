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
import { execSync, spawn } from 'child_process';
import { registerSpawn, updateAgent, AGENT_TYPES, HOOK_TYPES, registerHookExecution } from './agent-tracker.js';
import {
  readRotationState,
  writeRotationState,
  logRotationEvent,
  updateActiveCredentials,
  checkKeyHealth,
  selectActiveKey,
} from './key-sync.js';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_DIR = path.join(PROJECT_DIR, '.claude', 'state');
const QUOTA_INTERRUPTED_PATH = path.join(STATE_DIR, 'quota-interrupted-sessions.json');
const PAUSED_SESSIONS_PATH = path.join(STATE_DIR, 'paused-sessions.json');
const HISTORY_PATH = path.join(STATE_DIR, 'agent-tracker-history.json');
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// Limits
const MAX_REVIVALS_PER_CYCLE = 3;
const DEAD_SESSION_MAX_AGE_DAYS = 7;

// Lazy SQLite
let Database = null;
try {
  Database = (await import('better-sqlite3')).default;
} catch {
  // Non-fatal
}

/**
 * Count running automation agents.
 */
function countRunningAgents() {
  try {
    const result = execSync(
      "pgrep -cf 'claude.*--dangerously-skip-permissions'",
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
 * Build env for spawned claude processes.
 * Re-uses the same pattern as hourly-automation.js buildSpawnEnv().
 */
function buildSpawnEnv(agentId) {
  return {
    ...process.env,
    CLAUDE_PROJECT_DIR: PROJECT_DIR,
    CLAUDE_SPAWNED_SESSION: 'true',
    CLAUDE_AGENT_ID: agentId,
    HTTPS_PROXY: 'http://localhost:18080',
    HTTP_PROXY: 'http://localhost:18080',
    NO_PROXY: 'localhost,127.0.0.1',
  };
}

/**
 * Spawn a resumed claude session.
 * Returns true if spawn succeeded.
 */
function spawnResumedSession(sessionId, agentId, log) {
  const mcpConfig = path.join(PROJECT_DIR, '.mcp.json');
  const spawnArgs = [
    '--resume', sessionId,
    '--dangerously-skip-permissions',
    '--mcp-config', mcpConfig,
    '--output-format', 'json',
  ];

  try {
    const claude = spawn('claude', spawnArgs, {
      cwd: PROJECT_DIR,
      stdio: 'ignore',
      detached: true,
      env: buildSpawnEnv(agentId),
    });

    claude.unref();

    if (claude.pid) {
      updateAgent(agentId, { pid: claude.pid, status: 'running' });
      log(`  Resumed session ${sessionId.slice(0, 8)}... (PID ${claude.pid})`);
      return true;
    }

    return false;
  } catch (err) {
    log(`  Failed to resume session ${sessionId.slice(0, 8)}...: ${err.message}`);
    return false;
  }
}

// ============================================================================
// Mode 1: Quota-interrupted sessions
// ============================================================================

function reviveQuotaInterruptedSessions(log, maxRevivals) {
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

    // Check if older than 30 minutes (stale signal)
    const age = Date.now() - new Date(session.interruptedAt).getTime();
    if (age > 30 * 60 * 1000) {
      log(`  Quota-interrupted session ${session.agentId || 'unknown'} is stale (${Math.round(age / 60000)}m old), discarding.`);
      continue;
    }

    const sessionId = session.sessionId || extractSessionIdFromPath(session.transcriptPath);
    if (!sessionId) {
      log(`  Cannot determine session ID for ${session.agentId || 'unknown'}, skipping.`);
      continue;
    }

    // Register revival in agent tracker
    const newAgentId = registerSpawn({
      type: AGENT_TYPES.SESSION_REVIVED,
      hookType: HOOK_TYPES.SESSION_REVIVER,
      description: `Reviving quota-interrupted session ${sessionId.slice(0, 8)}`,
      prompt: `[resumed from quota interruption, original agent: ${session.agentId || 'unknown'}]`,
      metadata: {
        originalAgentId: session.agentId,
        originalSessionId: sessionId,
        revivalReason: 'quota_interrupted',
      },
    });

    if (spawnResumedSession(sessionId, newAgentId, log)) {
      revived++;
      session.status = 'revived';
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

  let history;
  try {
    if (!fs.existsSync(HISTORY_PATH)) return revived;
    history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    if (!Array.isArray(history.agents)) return revived;
  } catch {
    return revived;
  }

  const todoDbPath = path.join(PROJECT_DIR, '.claude', 'todo.db');
  if (!fs.existsSync(todoDbPath)) return revived;

  let db;
  try {
    db = new Database(todoDbPath, { readonly: true });
  } catch {
    return revived;
  }

  const sessionDir = getSessionDir(PROJECT_DIR);
  if (!sessionDir) {
    db.close();
    return revived;
  }

  const cutoff = Date.now() - DEAD_SESSION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

  try {
    for (const agent of history.agents) {
      if (revived >= maxRevivals) break;

      // Only look at reaped agents that died unexpectedly
      const isDead = (agent.status === 'completed' && agent.reapReason === 'process_already_dead') ||
                     (agent.status === 'reaped' && agent.reapReason === 'process_already_dead');
      if (!isDead) continue;

      // Must have a task ID
      const taskId = agent.metadata?.taskId;
      if (!taskId) continue;

      // Must be recent enough
      const agentTime = new Date(agent.timestamp).getTime();
      if (agentTime < cutoff) continue;

      // Check if TODO has been reset to pending (by the enhanced reaper)
      const task = db.prepare('SELECT id, status FROM tasks WHERE id = ? AND status = ?').get(taskId, 'pending');
      if (!task) continue;

      // Find session file
      const sessionFile = agent.sessionFile || findSessionFileByAgentId(sessionDir, agent.id);
      if (!sessionFile) continue;

      const sessionId = extractSessionIdFromPath(sessionFile);
      if (!sessionId) continue;

      log(`  Found dead session for task ${taskId}: ${sessionId.slice(0, 8)}...`);

      // Register revival
      const newAgentId = registerSpawn({
        type: AGENT_TYPES.SESSION_REVIVED,
        hookType: HOOK_TYPES.SESSION_REVIVER,
        description: `Reviving dead session for task ${taskId}`,
        prompt: `[resumed from dead session, original agent: ${agent.id}]`,
        metadata: {
          originalAgentId: agent.id,
          originalSessionId: sessionId,
          taskId,
          revivalReason: 'process_already_dead',
        },
      });

      if (spawnResumedSession(sessionId, newAgentId, log)) {
        revived++;
        // Mark task back to in_progress
        try {
          const writeDb = new Database(todoDbPath);
          writeDb.prepare("UPDATE tasks SET status = 'in_progress', started_at = datetime('now') WHERE id = ?").run(taskId);
          writeDb.close();
        } catch { /* non-fatal */ }
      }
    }
  } finally {
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
    if (keyData.status === 'invalid' || keyData.status === 'expired') continue;

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

    if (!session.sessionId) {
      continue;
    }

    const newAgentId = registerSpawn({
      type: AGENT_TYPES.SESSION_REVIVED,
      hookType: HOOK_TYPES.SESSION_REVIVER,
      description: `Resuming paused session ${session.sessionId.slice(0, 8)}`,
      prompt: `[resumed after account recovery, original agent: ${session.agentId || 'unknown'}]`,
      metadata: {
        originalAgentId: session.agentId,
        originalSessionId: session.sessionId,
        revivalReason: 'account_recovered',
      },
    });

    if (spawnResumedSession(session.sessionId, newAgentId, log)) {
      revived++;
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
export async function reviveInterruptedSessions(log, maxConcurrent = 5) {
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
  result.revivedQuota = reviveQuotaInterruptedSessions(log, remainingSlots);
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
