/**
 * Session Reaper — Detects dead/stuck sessions in the queue and cleans them up.
 *
 * Two-pass design:
 *   reapSyncPass(db) — fast, synchronous; called from drainQueue()
 *   reapAsyncPass(projectDir, stuckAliveItems, options) — async; called from hourly-automation
 *
 * IMPORTANT: This module must NOT import session-queue.js (circular dep).
 * It receives the db instance as a parameter for sync operations and opens
 * its own connection for async operations.
 *
 * @module lib/session-reaper
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync, execFileSync } from 'child_process';
import { auditEvent } from './session-audit.js';
import { killProcessGroup, killProcessGroupEscalated, killProcessesInDirectory } from './process-tree.js';
import { getCooldown } from '../config-reader.js';
import { debugLog } from './debug-log.js';
import { releaseAllResources, removeFromAllQueues } from './resource-lock.js';
import { removeWorktree as removeWorktreeCleanup } from './worktree-manager.js';

/**
 * Rename progress file to .retired instead of deleting immediately.
 * Deferred cleanup in reapAsyncPass sweeps files older than 30 minutes.
 */
function retireProgressFile(filePath) {
  try { fs.renameSync(filePath, filePath + '.retired'); } catch (_) { /* non-fatal */ }
}

// Lazy-loaded SQLite
let Database = null;
try {
  Database = (await import('better-sqlite3')).default;
} catch (err) {
  console.error('[session-reaper] Warning:', err.message);
  // Non-fatal: async reaping and TODO reconciliation will be degraded
}

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// Session file constants
const HEAD_BYTES = 16000;

/**
 * Parse a SQLite datetime string as UTC.
 * SQLite's datetime('now') produces "YYYY-MM-DD HH:MM:SS" (UTC, no Z suffix).
 * JavaScript's new Date() parses this as local time without timezone indicator.
 * This helper ensures correct UTC interpretation.
 */
function parseSqliteDatetime(str) {
  if (!str) return new Date(NaN);
  if (str.includes('T')) return new Date(str); // Already ISO 8601
  return new Date(str.replace(' ', 'T') + 'Z');
}
const TAIL_BYTES = 4000;
const TERMINAL_TOOL_BYTES = 16384;

// ============================================================================
// PID Utilities
// ============================================================================

/**
 * Check if a process is alive.
 * @param {number} pid
 * @returns {boolean}
 */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) { /* cleanup - failure expected */
    return false;
  }
}

/**
 * Check if a process is a zombie or stopped.
 * @param {number} pid
 * @returns {boolean}
 */
function isProcessZombieOrStopped(pid) {
  try {
    const state = execSync(`ps -o state= -p ${pid}`, {
      encoding: 'utf8',
      timeout: 3000,
      stdio: 'pipe',
    }).trim();
    return state === 'Z' || state === 'T';
  } catch (_) { /* cleanup - failure expected */
    return false; // Can't determine state — assume healthy
  }
}

/**
 * Kill a process with SIGTERM, wait, then SIGKILL if needed.
 * @param {number} pid
 * @returns {Promise<void>}
 */
async function killProcess(pid) {
  await killProcessGroupEscalated(pid);
}

// ============================================================================
// Session File Utilities (local copies — avoids circular dep via revival-utils)
// ============================================================================

/**
 * Discover the session directory for a project.
 * @param {string} projectDir
 * @returns {string|null}
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
 * Read the first N bytes of a file via fd seek.
 * @param {string} filePath
 * @param {number} numBytes
 * @returns {string}
 */
function readHead(filePath, numBytes) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(numBytes);
    const bytesRead = fs.readSync(fd, buf, 0, numBytes, 0);
    return buf.toString('utf8', 0, bytesRead);
  } catch (err) {
    console.error('[session-reaper] Warning:', err.message);
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Read the last N bytes of a file via fd seek.
 * @param {string} filePath
 * @param {number} numBytes
 * @returns {string}
 */
function readTail(filePath, numBytes) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const start = Math.max(0, stat.size - numBytes);
    const buf = Buffer.alloc(Math.min(numBytes, stat.size));
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8', 0, bytesRead);
  } catch (err) {
    console.error('[session-reaper] Warning:', err.message);
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Find session file by agent ID in a session directory.
 * @param {string} sessionDir
 * @param {string} agentId
 * @returns {string|null}
 */
function findSessionFileByAgentId(sessionDir, agentId) {
  const marker = `[AGENT:${agentId}]`;
  let files;
  try {
    files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'));
  } catch (err) {
    console.error('[session-reaper] Warning:', err.message);
    return null;
  }

  for (const file of files) {
    const filePath = path.join(sessionDir, file);
    const head = readHead(filePath, HEAD_BYTES);
    if (head.includes(marker)) return filePath;
  }

  return null;
}

/**
 * Check if a session's last assistant message indicates completion.
 * @param {string} sessionFile
 * @returns {boolean}
 */
function isSessionComplete(sessionFile) {
  const tail = readTail(sessionFile, TAIL_BYTES);
  if (!tail) return false;

  const lines = tail.split('\n').filter(l => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    let parsed;
    try { parsed = JSON.parse(lines[i]); } catch (err) {
      console.error('[session-reaper] Warning:', err.message);
      continue;
    }

    if (parsed.type !== 'assistant') return false;

    // Guard 1: If stop_reason is null/absent, model is still streaming
    const stopReason = parsed.message?.stop_reason;
    if (!stopReason) return false;

    const content = parsed.message?.content;
    if (!Array.isArray(content)) return true;

    // Guard 2: If ALL blocks are 'thinking', model hasn't produced output yet
    if (content.length > 0 && content.every(c => c.type === 'thinking')) return false;

    return !content.some(c => c.type === 'tool_use');
  }

  return false;
}

/**
 * Check if a session JSONL contains evidence of a terminal tool call
 * (complete_task or summarize_work) in the last 16KB.
 * @param {string} sessionFile
 * @returns {boolean}
 */
function sessionContainsTerminalTool(sessionFile) {
  const tail = readTail(sessionFile, TERMINAL_TOOL_BYTES);
  return tail.includes('"mcp__todo-db__complete_task"') ||
         tail.includes('"name":"complete_task"') ||
         tail.includes('"mcp__agent-tracker__summarize_work"') ||
         tail.includes('"name":"summarize_work"');
}

/**
 * Diagnose why a session failed by analyzing its JSONL tail.
 * Returns structured diagnosis for self-healing decisions.
 *
 * @param {string} sessionFile - Path to session JSONL file
 * @returns {{ stalled: boolean, error_type: string, is_transient: boolean,
 *             consecutive_errors: number, sample_error: string, suggested_action: string }}
 */
export function diagnoseSessionFailure(sessionFile) {
  const tail = readTail(sessionFile, 4096);
  if (!tail) return { stalled: false, error_type: 'unknown', is_transient: false, consecutive_errors: 0, sample_error: '', suggested_action: 'retry' };

  const lines = tail.split('\n').filter(l => l.trim());
  let consecutiveErrors = 0;
  let rateLimitCount = 0;
  let usageQuotaCount = 0;
  let authErrorCount = 0;
  let sampleError = '';

  for (let i = lines.length - 1; i >= 0 && consecutiveErrors < 10; i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      const isRateLimit = (parsed.error === 'rate_limit' && parsed.isApiErrorMessage === true) ||
        (parsed.type === 'error' && typeof parsed.message === 'string' && parsed.message.includes('rate limit'));
      const isAuthError = (parsed.error === 'authentication_error') ||
        (parsed.type === 'error' && typeof parsed.message === 'string' &&
         (parsed.message.includes('401') || parsed.message.includes('authentication')));
      // Detect Claude Code usage limit messages — these appear as both type: 'error'
      // AND as synthetic assistant messages (model: '<synthetic>', type: 'assistant')
      const msgText = (parsed.type === 'error' && typeof parsed.message === 'string')
        ? parsed.message
        : (parsed.type === 'assistant' && parsed.message?.model === '<synthetic>')
          ? (Array.isArray(parsed.message?.content)
            ? parsed.message.content.filter(c => c.type === 'text').map(c => c.text).join(' ')
            : '')
          : '';
      const isUsageLimit = msgText && (
        (msgText.includes('out of') && msgText.includes('usage')) ||
        msgText.includes('hit your limit') ||
        (msgText.includes('extra usage') && msgText.includes('resets')));

      if (isRateLimit || isAuthError || isUsageLimit) {
        consecutiveErrors++;
        if (isRateLimit) rateLimitCount++;
        if (isUsageLimit) usageQuotaCount++;
        if (isAuthError) authErrorCount++;
        if (!sampleError) {
          sampleError = (msgText || parsed.message || parsed.error || '').toString().slice(0, 200);
        }
      } else {
        break;
      }
    } catch { continue; }
  }

  const stalled = consecutiveErrors >= 3;

  // Classify error type
  let error_type = 'unknown';
  let is_transient = false;
  let suggested_action = 'retry';

  if (usageQuotaCount > 0) {
    error_type = 'usage_quota';
    is_transient = false;
    suggested_action = 'kill';
  } else if (rateLimitCount > 0 && rateLimitCount >= authErrorCount) {
    error_type = 'rate_limit';
    is_transient = true;
    suggested_action = 'cooldown';
  } else if (authErrorCount > 0) {
    error_type = 'auth_error';
    is_transient = false;
    suggested_action = 'diagnose_credentials';
  } else if (consecutiveErrors > 0) {
    error_type = 'crash';
    is_transient = false;
    suggested_action = 'investigate';
  }

  return { stalled, error_type, is_transient, consecutive_errors: consecutiveErrors, sample_error: sampleError, suggested_action };
}

/**
 * Check if a session is stuck in an auth/quota retry loop.
 * Thin wrapper around diagnoseSessionFailure() for backward compat.
 * @param {string} sessionFile
 * @returns {boolean}
 */
function isAuthStalled(sessionFile) {
  return diagnoseSessionFailure(sessionFile).stalled;
}

// ============================================================================
// Sync Pass — Called from drainQueue()
// ============================================================================

/**
 * Synchronous reaping pass: detect dead PIDs in running queue items.
 *
 * Called from drainQueue() — MUST be synchronous and fast.
 * Also kills stale persistent monitors and auth-stalled sessions directly
 * (no deferral to the async pass for these cases).
 *
 * @param {object} db - better-sqlite3 database instance (session-queue.db)
 * @returns {{ reaped: Array<{queueId: string, agentId: string, pid: number, revivalCandidate: boolean, metadata: object}>, stuckAlive: Array<{queueId: string, agentId: string, pid: number, spawnedAt: string, runDurationMs: number, agentType: string, title: string}> }}
 */
export function reapSyncPass(db) {
  const result = { reaped: [], stuckAlive: [], auditRevivals: [] };
  const hardKillMs = getCooldown('session_hard_kill_minutes', 60) * 60 * 1000;
  const now = Date.now();

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const sessionDir = getSessionDir(projectDir);

  // Clean up 'spawning' zombies — items that failed spawn before setting a PID.
  // Mark as failed if older than 5 minutes with no PID.
  try {
    const zombieResult = db.prepare(
      "UPDATE queue_items SET status = 'failed', error = 'spawn_zombie', completed_at = datetime('now') WHERE status = 'spawning' AND pid IS NULL AND enqueued_at < datetime('now', '-5 minutes')"
    ).run();
    if (zombieResult.changes > 0) {
      log(`Cleaned up ${zombieResult.changes} spawning zombie(s)`);
    }
  } catch (_) { /* non-fatal */ }

  // Only operate on 'running' items — 'suspended' items are intentionally paused
  // (preempted by CTO tasks) and must NOT be reaped. They have their own re-enqueue path.
  const running = db.prepare(
    "SELECT id, pid, agent_id, lane, spawn_type, spawned_at, agent_type, title, metadata FROM queue_items WHERE status = 'running'"
  ).all();

  for (const item of running) {
    if (!item.pid) continue;

    if (!isPidAlive(item.pid)) {
      // Dead PID — classify as 'completed' or 'failed' (no_output_crash) based on session output.
      // Sessions that died within 30 seconds with no JSONL output are classified as crash deaths.
      let reapStatus = 'completed';
      let reapError = null;
      const spawnedAt = item.spawned_at ? parseSqliteDatetime(item.spawned_at).getTime() : null;
      if (spawnedAt && !isNaN(spawnedAt)) {
        const durationMs = now - spawnedAt;
        if (durationMs < 30000 && sessionDir && item.agent_id) {
          try {
            const sessFile = findSessionFileByAgentId(sessionDir, item.agent_id);
            if (!sessFile) {
              reapStatus = 'failed';
              reapError = 'no_output_crash';
            }
          } catch { /* non-fatal — default to completed */ }
        }
      }

      // TOCTOU-safe: only transition from 'running' to prevent concurrent reap processes
      // from adding the same item to their reaped lists
      let reapResult;
      if (reapError) {
        reapResult = db.prepare("UPDATE queue_items SET status = 'failed', error = ?, completed_at = datetime('now') WHERE id = ? AND status = 'running'").run(reapError, item.id);
      } else {
        reapResult = db.prepare("UPDATE queue_items SET status = 'completed', completed_at = datetime('now') WHERE id = ? AND status = 'running'").run(item.id);
      }
      if (reapResult.changes === 0) continue; // Another process already reaped this item

      let metadata = {};
      try { metadata = item.metadata ? JSON.parse(item.metadata) : {}; } catch (err) {
        // Metadata parse failed — log but continue
        try { process.stderr.write(`[session-reaper] metadata parse error for ${item.id}: ${err.message}\n`); } catch (err) {
          console.error('[session-reaper] Warning:', err.message);
        }
      }

      const revivalCandidate = !!(metadata.taskId && item.spawn_type === 'fresh');

      auditEvent('session_reaped_dead', {
        queue_id: item.id,
        agent_id: item.agent_id,
        pid: item.pid,
        agent_type: item.agent_type,
        revival_candidate: revivalCandidate,
      });

      // Diagnose failure for persistent lane items (structured diagnosis for self-healing)
      let itemDiagnosis = null;
      if (item.lane === 'persistent' && sessionDir && item.agent_id) {
        try {
          const sessFile = findSessionFileByAgentId(sessionDir, item.agent_id);
          if (sessFile) {
            itemDiagnosis = diagnoseSessionFailure(sessFile);
          }
        } catch (_) { /* non-fatal — diagnosis is optional */ }
      }

      result.reaped.push({
        queueId: item.id,
        agentId: item.agent_id,
        pid: item.pid,
        revivalCandidate,
        metadata,
        agentType: item.agent_type,
        diagnosis: itemDiagnosis,
      });

      // Reset linked TODO task to pending so it can be re-spawned
      // For audit-lane sessions: if the task is still pending_audit, flag for auditor revival
      // instead of resetting to pending (which would lose the audit gate state)
      if (metadata.taskId && Database) {
        try {
          const todoDbPath = path.join(projectDir, '.claude', 'todo.db');
          if (fs.existsSync(todoDbPath)) {
            const todoDb = new Database(todoDbPath);
            todoDb.pragma('busy_timeout = 3000');
            const task = todoDb.prepare('SELECT id, status, gate_success_criteria, gate_verification_method, title FROM tasks WHERE id = ?').get(metadata.taskId);

            if (task && task.status === 'pending_audit' && item.lane === 'audit') {
              // Dead auditor — task stays in pending_audit, flag for re-spawn
              result.auditRevivals.push({
                taskId: metadata.taskId,
                taskType: metadata.taskType || 'todo',
                taskTitle: task.title || '',
                criteria: task.gate_success_criteria || '',
                method: task.gate_verification_method || '',
                queueId: item.id,
                agentId: item.agent_id,
              });
              debugLog('session-reaper', 'audit_revival_candidate', { taskId: metadata.taskId, lane: item.lane });
              try { auditEvent('audit_revival_candidate', { queue_id: item.id, task_id: metadata.taskId, agent_id: item.agent_id }); } catch (_) { /* non-fatal */ }
            } else if (!task && item.lane === 'audit' && metadata.taskType === 'persistent') {
              // Persistent task audit — check persistent-tasks.db instead
              try {
                const ptDbPath = path.join(projectDir, '.claude', 'state', 'persistent-tasks.db');
                if (fs.existsSync(ptDbPath)) {
                  const ptDb = new Database(ptDbPath, { readonly: true });
                  ptDb.pragma('busy_timeout = 3000');
                  const ptTask = ptDb.prepare('SELECT id, status, title, gate_success_criteria, gate_verification_method FROM persistent_tasks WHERE id = ?').get(metadata.taskId);
                  ptDb.close();
                  if (ptTask && ptTask.status === 'pending_audit') {
                    result.auditRevivals.push({
                      taskId: metadata.taskId,
                      taskType: 'persistent',
                      taskTitle: ptTask.title || '',
                      criteria: ptTask.gate_success_criteria || '',
                      method: ptTask.gate_verification_method || '',
                      queueId: item.id,
                      agentId: item.agent_id,
                    });
                    debugLog('session-reaper', 'pt_audit_revival_candidate', { taskId: metadata.taskId });
                    try { auditEvent('audit_revival_candidate', { queue_id: item.id, task_id: metadata.taskId, task_type: 'persistent', agent_id: item.agent_id }); } catch (_) { /* non-fatal */ }
                  }
                }
              } catch (_) { /* non-fatal */ }
            } else if (!task && item.lane === 'audit' && (metadata.taskType === 'plan' || metadata.planId)) {
              // Plan task audit — check plans.db
              // Matches both: buildAuditorSessionSpec sets taskType:'plan', plan-audit-spawner sets planId
              try {
                const plansDbPath = path.join(projectDir, '.claude', 'state', 'plans.db');
                if (fs.existsSync(plansDbPath)) {
                  const plansDb = new Database(plansDbPath, { readonly: true });
                  plansDb.pragma('busy_timeout = 3000');
                  const planTask = plansDb.prepare('SELECT id, title, verification_strategy, status FROM plan_tasks WHERE id = ?').get(metadata.taskId);
                  plansDb.close();
                  if (planTask && planTask.status === 'pending_audit') {
                    result.auditRevivals.push({
                      taskId: metadata.taskId,
                      taskType: 'plan',
                      taskTitle: planTask.title || '',
                      criteria: planTask.verification_strategy || '',
                      method: planTask.verification_strategy || '',
                      queueId: item.id,
                      agentId: item.agent_id,
                    });
                    debugLog('session-reaper', 'plan_audit_revival_candidate', { taskId: metadata.taskId });
                    try { auditEvent('audit_revival_candidate', { queue_id: item.id, task_id: metadata.taskId, task_type: 'plan', agent_id: item.agent_id }); } catch (_) { /* non-fatal */ }
                  }
                }
              } catch (_) { /* non-fatal */ }
            } else if (!task && item.lane === 'audit' && metadata.taskType === 'authorization') {
              // Authorization audit — check cto_decisions in bypass-requests.db
              try {
                const bypassDbPath = path.join(projectDir, '.claude', 'state', 'bypass-requests.db');
                if (fs.existsSync(bypassDbPath)) {
                  const bypassDb = new Database(bypassDbPath, { readonly: true });
                  bypassDb.pragma('busy_timeout = 3000');
                  const decision = bypassDb.prepare('SELECT id, status, decision_type, verbatim_text, decision_context, session_id FROM cto_decisions WHERE id = ?').get(metadata.taskId);
                  bypassDb.close();
                  if (decision && decision.status === 'audit_pending') {
                    result.auditRevivals.push({
                      taskId: metadata.taskId,
                      taskType: 'authorization',
                      taskTitle: `CTO decision: ${decision.decision_type || 'unknown'}`,
                      criteria: decision.verbatim_text || '',
                      method: decision.decision_context || '',
                      queueId: item.id,
                      agentId: item.agent_id,
                      // Extra fields for authorization auditor revival
                      decisionType: decision.decision_type,
                      verbatimText: decision.verbatim_text,
                      decisionContext: decision.decision_context,
                      sessionId: decision.session_id,
                    });
                    debugLog('session-reaper', 'authorization_audit_revival_candidate', { taskId: metadata.taskId });
                    try { auditEvent('audit_revival_candidate', { queue_id: item.id, task_id: metadata.taskId, task_type: 'authorization', agent_id: item.agent_id }); } catch (_) { /* non-fatal */ }
                  }
                }
              } catch (_) { /* non-fatal */ }
            } else if (task && task.status === 'in_progress') {
              const resetResult = todoDb.prepare(
                "UPDATE tasks SET status = 'pending', started_at = NULL, started_timestamp = NULL WHERE id = ? AND status = 'in_progress'"
              ).run(metadata.taskId);
              if (resetResult.changes > 0) {
                debugLog('session-reaper', 'todo_reset_dead_pid', { taskId: metadata.taskId });
                try { auditEvent('task_reset_on_reap', { queue_id: item.id, task_id: metadata.taskId, agent_id: item.agent_id }); } catch (_) { /* non-fatal */ }
              }
            }

            todoDb.close();
          }
        } catch (_) { /* non-fatal */ }
      }

      // Retire progress file for dead agent (deferred cleanup in reapAsyncPass)
      retireProgressFile(path.join(projectDir, '.claude', 'state', 'agent-progress', `${item.agent_id}.json`));

      // Release display lock if this dead agent held it
      if (item.agent_id) {
        try {
          releaseAllResources(item.agent_id);
          removeFromAllQueues(item.agent_id);
          try { auditEvent('resources_released_on_reap', { queue_id: item.id, agent_id: item.agent_id }); } catch (_) { /* non-fatal */ }
        } catch (_) { /* non-fatal */ }
      }

      // Reactive worktree cleanup: if the dead agent was in a worktree, clean it up immediately
      // instead of waiting for the 5-min background sweep. Only remove if the worktree is clean
      // AND no surviving child processes are detected.
      const worktreePath = metadata?.worktreePath || item.worktree_path;
      if (worktreePath && fs.existsSync(worktreePath)) {
        try {
          // Check for surviving child processes before destroying the worktree (fail-closed)
          let hasActiveProcesses = false;
          try {
            const lsofResult = execFileSync('lsof', ['+D', worktreePath, '-t'], {
              encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
            });
            if (lsofResult.trim().length > 0) {
              hasActiveProcesses = true;
              debugLog('session-reaper', 'worktree_cleanup_skipped_active_processes', {
                agent_id: item.agent_id, worktree_path: worktreePath,
                pids: lsofResult.trim().split('\n').filter(Boolean),
              });
            }
          } catch (lsofErr) {
            // lsof exit code 1 with empty stdout = no processes found — safe to proceed.
            // Any other error = fail-closed: skip worktree cleanup.
            if (lsofErr.status === 1 && (!lsofErr.stdout || lsofErr.stdout.trim().length === 0)) {
              hasActiveProcesses = false;
            } else {
              hasActiveProcesses = true;
              debugLog('session-reaper', 'worktree_cleanup_skipped_lsof_error', {
                agent_id: item.agent_id, worktree_path: worktreePath, error: lsofErr.message,
              });
            }
          }

          // Helper: check git status and remove worktree if clean
          const tryCleanWorktree = () => {
            const gitStatus = execSync('git status --porcelain', {
              cwd: worktreePath, encoding: 'utf8', timeout: 5000, stdio: 'pipe',
            }).trim();
            if (gitStatus.length === 0) {
              const wtBranch = execSync('git branch --show-current', {
                cwd: worktreePath, encoding: 'utf8', timeout: 5000, stdio: 'pipe',
              }).trim();
              if (wtBranch) {
                removeWorktreeCleanup(wtBranch, { force: true }); // force: safety already verified by caller
                debugLog(`[session-reaper] Cleaned up worktree for dead agent ${item.agent_id}: ${wtBranch}`);
                try { auditEvent('worktree_cleaned_on_reap', { queue_id: item.id, agent_id: item.agent_id, worktree_path: metadata?.worktreePath || item.worktree_path }); } catch (_) { /* non-fatal */ }
              }
            }
            // Dirty worktrees are left for rescueAbandonedWorktrees()
          };

          if (!hasActiveProcesses) {
            tryCleanWorktree();
          } else {
            // Active processes found (orphaned dev servers, etc.) but owning agent is dead.
            // Cross-reference session-queue to confirm no live session owns this worktree.
            // If no session claims it, kill the orphaned processes and proceed with cleanup.
            let sessionOwnsWorktree = true; // fail-closed default
            const queueDbPath = path.join(projectDir, '.claude', 'state', 'session-queue.db');
            if (Database && fs.existsSync(queueDbPath)) {
              try {
                const qDb = new Database(queueDbPath, { readonly: true });
                qDb.pragma('busy_timeout = 2000');
                const active = qDb.prepare(
                  "SELECT id FROM queue_items WHERE status IN ('running', 'queued', 'spawning', 'suspended') AND (cwd = ? OR worktree_path = ?)"
                ).get(worktreePath, worktreePath);
                qDb.close();
                sessionOwnsWorktree = !!active;
              } catch (_) { /* fail-closed: assume owned */ }
            }

            if (!sessionOwnsWorktree) {
              // Kill orphaned processes, then attempt worktree cleanup
              try {
                const killLsof = execFileSync('lsof', ['+D', worktreePath, '-t'], {
                  encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
                });
                const pids = killLsof.trim().split('\n').filter(Boolean).map(Number)
                  .filter(p => p > 0 && p !== process.pid);
                for (const pid of pids) {
                  try { killProcessGroup(pid); } catch (_) { /* already dead */ }
                }
              } catch (_) { /* non-fatal — processes may already be gone */ }

              // Brief pause for process cleanup to take effect
              const buf = new SharedArrayBuffer(4);
              Atomics.wait(new Int32Array(buf), 0, 0, 1000);

              try { tryCleanWorktree(); } catch (_) { /* non-fatal */ }
              debugLog(`[session-reaper] Killed orphaned processes and cleaned worktree for dead agent ${item.agent_id}`);
            }
          }
        } catch (_) { /* non-fatal — background sweep will catch it */ }
      }
    } else if (item.lane === 'gate') {
      // Gate agents are lightweight Haiku sessions — skip stuck-alive checks.
      // Dead gate PIDs are already reaped above (dead PID detection has no lane exemption).
      continue;
    } else if (item.lane === 'persistent') {
      // Persistent monitors are long-running by design — don't use elapsed time.
      // Instead, check heartbeat staleness: if the persistent task's heartbeat
      // hasn't updated in 2+ minutes, the monitor is stuck (e.g., auth zombie).
      try {
        const ptDbPath = path.join(projectDir, '.claude', 'state', 'persistent-tasks.db');
        if (Database && fs.existsSync(ptDbPath)) {
          let taskId = null;
          try { taskId = item.metadata ? JSON.parse(item.metadata).persistentTaskId : null; } catch { /* ignore */ }
          if (taskId) {
            const ptDb = new Database(ptDbPath, { readonly: true });
            const task = ptDb.prepare("SELECT last_heartbeat FROM persistent_tasks WHERE id = ?").get(taskId);
            ptDb.close();
            if (task && task.last_heartbeat) {
              const heartbeatAge = now - parseSqliteDatetime(task.last_heartbeat).getTime();
              const STALE_HEARTBEAT_MS = getCooldown('persistent_heartbeat_stale_minutes', 5) * 60 * 1000;

              // Spawn grace period: skip heartbeat check if this monitor was spawned
              // less than 120 seconds ago. New monitors inherit the previous monitor's
              // frozen heartbeat — without this grace period, they get killed before
              // they can make their first tool call and update the heartbeat.
              const spawnedMs = item.spawned_at ? now - parseSqliteDatetime(item.spawned_at).getTime() : Infinity;
              const SPAWN_GRACE_MS = 60_000; // 60 seconds

              if (heartbeatAge > STALE_HEARTBEAT_MS && spawnedMs > SPAWN_GRACE_MS) {
                // Kill entire process group in sync pass — don't defer to async pass
                killProcessGroup(item.pid);
                db.prepare("UPDATE queue_items SET status = 'completed', completed_at = datetime('now') WHERE id = ?")
                  .run(item.id);

                let metadata = {};
                try { metadata = item.metadata ? JSON.parse(item.metadata) : {}; } catch { /* ignore */ }

                result.reaped.push({
                  queueId: item.id,
                  agentId: item.agent_id,
                  pid: item.pid,
                  metadata,
                  revivalCandidate: true,
                  reapReason: 'stale_heartbeat',
                  diagnosis: null,
                });

                auditEvent('session_reaped_dead', {
                  queue_id: item.id,
                  agent_id: item.agent_id,
                  pid: item.pid,
                  reason: 'stale_heartbeat',
                  stale_ms: heartbeatAge,
                });

                // Retire progress file (deferred cleanup in reapAsyncPass)
                retireProgressFile(path.join(projectDir, '.claude', 'state', 'agent-progress', `${item.agent_id}.json`));

                // Release display lock if this stale monitor held it
                if (item.agent_id) {
                  try { releaseAllResources(item.agent_id); removeFromAllQueues(item.agent_id); } catch (_) { /* non-fatal */ }
                }
              }
            }
          }
        }
      } catch (_) { /* non-fatal — best effort heartbeat check */ }
    } else if (item.spawned_at) {
      const elapsed = now - parseSqliteDatetime(item.spawned_at).getTime();
      const AUTH_STALL_MS = getCooldown('auth_stall_detection_minutes', 2) * 60 * 1000;

      // Auth-stall fast path: check JSONL mtime + tail for auth errors
      if (elapsed > AUTH_STALL_MS && item.agent_id && sessionDir) {
        try {
          const sessionFile = findSessionFileByAgentId(sessionDir, item.agent_id);
          if (sessionFile) {
            const stat = fs.statSync(sessionFile);
            const staleMs = now - stat.mtimeMs;
            if (staleMs > AUTH_STALL_MS && isAuthStalled(sessionFile)) {
              killProcessGroup(item.pid);
              db.prepare("UPDATE queue_items SET status = 'completed', completed_at = datetime('now') WHERE id = ?")
                .run(item.id);

              let metadata = {};
              try { metadata = item.metadata ? JSON.parse(item.metadata) : {}; } catch { /* ignore */ }

              // Diagnose the auth-stall for self-healing context
              let authStallDiagnosis = null;
              try { authStallDiagnosis = diagnoseSessionFailure(sessionFile); } catch (_) { /* non-fatal */ }

              result.reaped.push({
                queueId: item.id,
                agentId: item.agent_id,
                pid: item.pid,
                metadata,
                revivalCandidate: true,
                reapReason: 'auth_stall',
                diagnosis: authStallDiagnosis,
              });

              auditEvent('session_reaped_dead', {
                queue_id: item.id,
                agent_id: item.agent_id,
                pid: item.pid,
                reason: 'auth_stall',
                stale_ms: staleMs,
              });

              // Retire progress file (deferred cleanup in reapAsyncPass)
              retireProgressFile(path.join(projectDir, '.claude', 'state', 'agent-progress', `${item.agent_id}.json`));

              // Release display lock if this auth-stalled agent held it
              if (item.agent_id) {
                try { releaseAllResources(item.agent_id); removeFromAllQueues(item.agent_id); } catch (_) { /* non-fatal */ }
              }

              continue; // Skip the normal elapsed-time check for this item
            }
          }
        } catch (_) { /* non-fatal — fall through to normal elapsed check */ }
      }

      // Usage-quota stall: session is alive and retrying, but quota is exhausted.
      // Unlike auth stalls, these sessions keep JSONL fresh via retries.
      // No mtime gate — check JSONL content directly.
      if (elapsed > AUTH_STALL_MS && item.agent_id && sessionDir) {
        try {
          const sessionFile = findSessionFileByAgentId(sessionDir, item.agent_id);
          if (sessionFile) {
            const quotaDiagnosis = diagnoseSessionFailure(sessionFile);
            if (quotaDiagnosis.stalled && quotaDiagnosis.error_type === 'usage_quota') {
              killProcessGroup(item.pid);
              db.prepare("UPDATE queue_items SET status = 'completed', completed_at = datetime('now') WHERE id = ?")
                .run(item.id);

              let metadata = {};
              try { metadata = item.metadata ? JSON.parse(item.metadata) : {}; } catch { /* ignore */ }

              result.reaped.push({
                queueId: item.id,
                agentId: item.agent_id,
                pid: item.pid,
                metadata,
                revivalCandidate: true,
                reapReason: 'usage_quota_stall',
                diagnosis: quotaDiagnosis,
              });

              auditEvent('session_reaped_dead', {
                queue_id: item.id,
                agent_id: item.agent_id,
                pid: item.pid,
                reason: 'usage_quota_stall',
              });

              retireProgressFile(path.join(projectDir, '.claude', 'state', 'agent-progress', `${item.agent_id}.json`));
              if (item.agent_id) {
                try { releaseAllResources(item.agent_id); removeFromAllQueues(item.agent_id); } catch (_) { /* non-fatal */ }
              }
              continue;
            }
          }
        } catch (_) { /* non-fatal */ }
      }

      // Existing hard-kill threshold check (30 min)
      if (elapsed > hardKillMs) {
        result.stuckAlive.push({
          queueId: item.id,
          agentId: item.agent_id,
          pid: item.pid,
          spawnedAt: item.spawned_at,
          runDurationMs: elapsed,
          agentType: item.agent_type,
          title: item.title,
          metadata: item.metadata,
        });
      }
    }
  }

  debugLog('session-reaper', 'sync_pass', { reapedCount: result.reaped.length, stuckAliveCount: result.stuckAlive.length });

  return result;
}

// ============================================================================
// Async Pass — Called from hourly-automation
// ============================================================================

/**
 * Asynchronous reaping pass: handle stuck-alive sessions via hard kill.
 *
 * For each stuck-alive item, performs multi-signal completion check:
 *   1. Session JSONL complete (no pending tool_use)
 *   2. Terminal tool called (complete_task or summarize_work)
 *   3. Process zombie/stopped state
 *
 * @param {string} projectDir - Project directory
 * @param {Array} stuckAliveItems - Items from getStuckAliveSessions()
 * @param {object} [options]
 * @param {function} [options.log] - Log function
 * @returns {Promise<{ completedReaped: number, hardKilled: number }>}
 */
export async function reapAsyncPass(projectDir, stuckAliveItems, options = {}) {
  const log = options.log || (() => {});
  const result = { completedReaped: 0, hardKilled: 0 };

  if (!Database) {
    log('Session reaper: better-sqlite3 not available, skipping async pass');
    return result;
  }

  const dbPath = path.join(projectDir, '.claude', 'state', 'session-queue.db');
  if (!fs.existsSync(dbPath)) return result;

  let db;
  try {
    db = new Database(dbPath);
    db.pragma('busy_timeout = 5000');
  } catch (err) {
    log(`Session reaper: cannot open queue DB: ${err.message}`);
    return result;
  }

  const sessionDir = getSessionDir(projectDir);

  try {
    for (const item of stuckAliveItems) {
      // Explicit safety guard: never reap suspended items (preempted by CTO tasks).
      // getStuckAliveSessions already filters for status='running', but double-check here.
      const currentStatus = db.prepare("SELECT status, lane FROM queue_items WHERE id = ?").get(item.queueId);
      if (currentStatus && currentStatus.status === 'suspended') {
        log(`Session reaper: skipping suspended item ${item.queueId} (preempted by CTO task)`);
        continue;
      }

      // Per-task hard-kill timeout override: check if the associated persistent task
      // has a custom hard_kill_minutes in its metadata, allowing some tasks to run longer.
      let itemHardKillMs = getCooldown('session_hard_kill_minutes', 60) * 60 * 1000; // global default
      try {
        const meta = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : (item.metadata || {});
        if (meta.persistentTaskId) {
          const ptDbPath = path.join(projectDir, '.claude', 'state', 'persistent-tasks.db');
          if (Database && fs.existsSync(ptDbPath)) {
            const ptDb = new Database(ptDbPath, { readonly: true });
            const pt = ptDb.prepare("SELECT metadata FROM persistent_tasks WHERE id = ?").get(meta.persistentTaskId);
            ptDb.close();
            if (pt?.metadata) {
              const ptMeta = JSON.parse(pt.metadata);
              if (typeof ptMeta.hard_kill_minutes === 'number' && ptMeta.hard_kill_minutes > 0) {
                itemHardKillMs = ptMeta.hard_kill_minutes * 60 * 1000;
              }
            }
          }
        }
      } catch (_) { /* non-fatal — use global default */ }

      // If per-task timeout is longer than the elapsed time, give it more time
      if (item.runDurationMs < itemHardKillMs) {
        log(`Session reaper: skipping ${item.agentId} — per-task timeout ${Math.round(itemHardKillMs / 60000)}min not yet reached (elapsed ${Math.round(item.runDurationMs / 60000)}min)`);
        continue;
      }

      // Persistent lane: only reap if heartbeat is stale (detected by sync pass).
      // Normal persistent monitors are never in stuckAlive — only stale-heartbeat ones.
      const effectiveLane = item.lane || (currentStatus && currentStatus.lane) || null;
      if (effectiveLane === 'persistent' && !item.staleHeartbeatMs) {
        log(`Session reaper: skipping persistent item ${item.queueId} (long-running, heartbeat healthy)`);
        continue;
      }
      if (effectiveLane === 'persistent' && item.staleHeartbeatMs) {
        log(`Session reaper: killing stale persistent monitor ${item.queueId} (heartbeat ${Math.round(item.staleHeartbeatMs / 60000)}min stale)`);
        await killProcess(item.pid);
        db.prepare("UPDATE queue_items SET status = 'completed', completed_at = datetime('now') WHERE id = ?")
          .run(item.queueId);
        auditEvent('session_reaped_complete', {
          queue_id: item.queueId,
          agent_id: item.agentId,
          pid: item.pid,
          reason: 'stale_heartbeat',
          stale_heartbeat_ms: item.staleHeartbeatMs,
        });
        result.completedReaped++;
        continue;
      }

      // Find session file for JSONL analysis
      let sessionFile = null;
      if (sessionDir && item.agentId) {
        sessionFile = findSessionFileByAgentId(sessionDir, item.agentId);
      }

      // Multi-signal completion check
      const isComplete = sessionFile && isSessionComplete(sessionFile);
      const hasTerminalTool = sessionFile && sessionContainsTerminalTool(sessionFile);
      const isZombieOrStopped = isProcessZombieOrStopped(item.pid);

      if (isComplete || hasTerminalTool || isZombieOrStopped) {
        // Session finished but process lingered — graceful cleanup
        log(`Session reaper: reaping completed session ${item.agentId} (PID ${item.pid}, ${Math.round(item.runDurationMs / 60000)}min)`);
        await killProcess(item.pid);

        db.prepare("UPDATE queue_items SET status = 'completed', completed_at = datetime('now') WHERE id = ?")
          .run(item.queueId);

        auditEvent('session_reaped_complete', {
          queue_id: item.queueId,
          agent_id: item.agentId,
          pid: item.pid,
          run_duration_ms: item.runDurationMs,
          signals: { isComplete, hasTerminalTool, isZombieOrStopped },
        });

        // Reconcile TODO — mark completed if terminal tool was called
        if (hasTerminalTool) {
          reconcileTodo(item, projectDir, 'session_reaped_complete');
        }

        result.completedReaped++;
      } else {
        // Truly stuck — hard kill
        log(`Session reaper: HARD KILLING stuck session ${item.agentId} (PID ${item.pid}, ${Math.round(item.runDurationMs / 60000)}min, no completion signal)`);
        await killProcess(item.pid);

        db.prepare("UPDATE queue_items SET status = 'failed', error = 'hard_kill_timeout', completed_at = datetime('now') WHERE id = ?")
          .run(item.queueId);

        auditEvent('session_hard_killed', {
          queue_id: item.queueId,
          agent_id: item.agentId,
          pid: item.pid,
          run_duration_ms: item.runDurationMs,
          agent_type: item.agentType,
        });

        // Reset linked TODO to pending
        reconcileTodo(item, projectDir, 'session_hard_killed');

        // Kill orphaned child processes in the worktree (esbuild, tsc --watch, dev servers)
        // that survive after the Claude process is killed
        const hardKillMeta = typeof item.metadata === 'string' ? (() => { try { return JSON.parse(item.metadata); } catch { return {}; } })() : (item.metadata || {});
        const hardKillWtPath = hardKillMeta.worktreePath || item.worktree_path;
        if (hardKillWtPath && fs.existsSync(hardKillWtPath)) {
          try {
            killProcessesInDirectory(hardKillWtPath);
            log(`Session reaper: killed orphaned processes in worktree ${hardKillWtPath}`);
          } catch (_) { /* non-fatal — orphan process reaper will catch these later */ }
        }

        // Release resource locks held by the hard-killed agent
        if (item.agentId) {
          try { releaseAllResources(item.agentId); removeFromAllQueues(item.agentId); } catch (_) { /* non-fatal */ }
        }

        // Write deputy-CTO report
        writeDeputyCtoReport(projectDir, item);

        result.hardKilled++;
      }
    }
  } catch (err) {
    log(`Session reaper async pass error: ${err.message}`);
  } finally {
    try { db.close(); } catch (_) { /* cleanup - failure expected */}
  }

  debugLog('session-reaper', 'async_pass', { completedReaped: result.completedReaped, hardKilled: result.hardKilled });

  // Clean up retired progress files older than 30 minutes
  const PROGRESS_RETIRE_TTL_MS = 30 * 60 * 1000;
  const progressDir = path.join(projectDir, '.claude', 'state', 'agent-progress');
  try {
    if (fs.existsSync(progressDir)) {
      for (const entry of fs.readdirSync(progressDir)) {
        if (!entry.endsWith('.retired')) continue;
        try {
          const fp = path.join(progressDir, entry);
          if (Date.now() - fs.statSync(fp).mtimeMs > PROGRESS_RETIRE_TTL_MS) fs.unlinkSync(fp);
        } catch (_) { /* non-fatal */ }
      }
    }
  } catch (_) { /* non-fatal */ }

  return result;
}

// ============================================================================
// Convenience Query — Called from hourly-automation
// ============================================================================

/**
 * Get running sessions that have exceeded the hard kill threshold.
 *
 * Opens its own DB connection (safe for async caller context).
 *
 * @returns {Array<{queueId: string, agentId: string, pid: number, spawnedAt: string, runDurationMs: number, agentType: string, title: string, lane: string, metadata: string}>}
 */
export function getStuckAliveSessions() {
  if (!Database) return [];

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const dbPath = path.join(projectDir, '.claude', 'state', 'session-queue.db');
  if (!fs.existsSync(dbPath)) return [];

  let db;
  try {
    db = new Database(dbPath, { readonly: true });
    db.pragma('busy_timeout = 5000');

    const hardKillMs = getCooldown('session_hard_kill_minutes', 60) * 60 * 1000;
    const cutoffTime = new Date(Date.now() - hardKillMs).toISOString();

    // Only query 'running' items — 'suspended' items must never be hard-killed
    // (they are intentionally preempted by CTO tasks and have a re-enqueue path)
    const items = db.prepare(
      "SELECT id, pid, agent_id, spawned_at, agent_type, title, lane, metadata FROM queue_items WHERE status = 'running' AND lane NOT IN ('gate', 'persistent') AND spawned_at < ?"
    ).all(cutoffTime);

    const now = Date.now();
    return items.filter(item => item.pid && isPidAlive(item.pid)).map(item => ({
      queueId: item.id,
      agentId: item.agent_id,
      pid: item.pid,
      spawnedAt: item.spawned_at,
      runDurationMs: now - parseSqliteDatetime(item.spawned_at).getTime(),
      agentType: item.agent_type,
      title: item.title,
      lane: item.lane,
      metadata: item.metadata,
    }));
  } catch (err) {
    try { process.stderr.write(`[session-reaper] getStuckAliveSessions error: ${err.message}\n`); } catch (err) {
      console.error('[session-reaper] Warning:', err.message);
    }
    return [];
  } finally {
    if (db) try { db.close(); } catch (_) { /* cleanup - failure expected */}
  }
}

// ============================================================================
// TODO Reconciliation
// ============================================================================

/**
 * Reconcile a TODO item after reaping.
 *
 * @param {object} item - Queue item with metadata field (string or parsed)
 * @param {string} projectDir - Project directory
 * @param {string} reason - 'session_reaped_complete' or 'session_hard_killed'
 */
function reconcileTodo(item, projectDir, reason) {
  if (!Database) return;

  let metadata = item.metadata;
  if (typeof metadata === 'string') {
    try { metadata = JSON.parse(metadata); } catch (_) { /* cleanup - failure expected */ return; }
  }
  if (!metadata) return;

  const taskId = metadata.taskId;
  if (!taskId) return;

  const todoDbPath = path.join(projectDir, '.claude', 'todo.db');
  if (!fs.existsSync(todoDbPath)) return;

  let db;
  try {
    db = new Database(todoDbPath);

    const task = db.prepare('SELECT id, status FROM tasks WHERE id = ?').get(taskId);
    if (!task || !['in_progress', 'pending_audit', 'pending'].includes(task.status)) return;

    if (reason === 'session_reaped_complete') {
      db.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run(taskId);
    } else if (reason === 'session_hard_killed') {
      db.prepare("UPDATE tasks SET status = 'pending', started_at = NULL, started_timestamp = NULL WHERE id = ?").run(taskId);
    }
  } catch (err) {
    try { process.stderr.write(`[session-reaper] reconcileTodo error: ${err.message}\n`); } catch (err) {
      console.error('[session-reaper] Warning:', err.message);
    }
  } finally {
    if (db) try { db.close(); } catch (_) { /* cleanup - failure expected */}
  }
}

// ============================================================================
// Deputy-CTO Report
// ============================================================================

/**
 * Write a deputy-CTO report for a hard-killed session.
 *
 * @param {string} projectDir - Project directory
 * @param {object} item - Stuck-alive queue item
 */
function writeDeputyCtoReport(projectDir, item) {
  if (!Database) return;

  const dbPath = path.join(projectDir, '.claude', 'cto-reports.db');
  if (!fs.existsSync(dbPath)) return;

  let db;
  try {
    db = new Database(dbPath);

    const idempotencyKey = `hard_kill_${item.queueId}`;

    // Check idempotency
    const existing = db.prepare('SELECT id FROM reports WHERE idempotency_key = ?').get(idempotencyKey);
    if (existing) return;

    const now = new Date();
    const id = `reaper-${item.queueId}`;

    db.prepare(`
      INSERT INTO reports (id, reporting_agent, title, summary, category, priority, created_at, created_timestamp, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      'session-reaper',
      `Hard-killed stuck session: ${item.title || item.agentId}`,
      `Session ${item.agentId} (PID ${item.pid}, queue ${item.queueId}) was hard-killed after ${Math.round(item.runDurationMs / 60000)}min with no completion signal. Agent type: ${item.agentType}. This may indicate a hung agent or infinite loop.`,
      'automation',
      'urgent',
      now.toISOString(),
      now.toISOString(),
      idempotencyKey,
    );
  } catch (err) {
    try { process.stderr.write(`[session-reaper] writeDeputyCtoReport error: ${err.message}\n`); } catch (err) {
      console.error('[session-reaper] Warning:', err.message);
    }
  } finally {
    if (db) try { db.close(); } catch (_) { /* cleanup - failure expected */}
  }
}
