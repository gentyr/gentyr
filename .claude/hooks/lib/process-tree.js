/**
 * Process Tree Utilities — Kill process groups, not just lead PIDs.
 *
 * GENTYR spawns agent sessions with `detached: true`, making the spawned
 * process the leader of a new process group. These utilities send signals
 * to the entire group (negative PID), ensuring child processes (esbuild,
 * vitest, dev servers) are also terminated during cleanup.
 *
 * @module lib/process-tree
 * @version 1.0.0
 */

import { execFileSync } from 'child_process';
import { auditEvent } from './session-audit.js';

/**
 * Verify a PID belongs to a Claude/GENTYR process before killing.
 * Returns false (fail-safe: don't kill) if verification fails or process is not ours.
 */
export function isClaudeProcess(pid) {
  if (!pid || pid <= 0) return false;
  try {
    const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!cmd) return false;
    return /\bclaude\b/i.test(cmd)
      || /\bnode\b.*\.claude[/\\]/i.test(cmd)
      || /\bnode\b.*gentyr/i.test(cmd)
      || /\besbuild\b/.test(cmd)
      || /\bvitest\b/.test(cmd);
  } catch (_) {
    return false;
  }
}

/** Log a kill attempt to the audit trail. Non-fatal. */
function logKillAttempt(pid, signal, context = {}) {
  try {
    auditEvent('process_kill_attempt', { pid, signal, ...context });
  } catch (_) { /* non-fatal */ }
}

/**
 * Kill an entire process group (synchronous, immediate).
 * Sends signal to -pid (negative PID = process group).
 * Falls back to killing just the lead PID if group kill fails with EPERM.
 *
 * @param {number} pid - Process group leader PID
 * @param {string} [signal='SIGTERM'] - Signal to send
 * @returns {boolean} true if signal was sent successfully
 */
export function killProcessGroup(pid, signal = 'SIGTERM') {
  if (!pid || pid <= 0) return false;
  if (!isClaudeProcess(pid)) {
    logKillAttempt(pid, signal, { blocked: true, reason: 'pid_not_claude' });
    return false;
  }
  logKillAttempt(pid, signal, { verified: true });
  try {
    process.kill(-pid, signal);
    return true;
  } catch (err) {
    if (err.code === 'EPERM') {
      // Can't kill the group — fall back to lead PID only
      try {
        process.kill(pid, signal);
        return true;
      } catch (_) { /* already dead */ }
    }
    // ESRCH = no such process — already dead, that's fine
    return false;
  }
}

/**
 * Kill a process group with SIGTERM/SIGKILL escalation (async).
 * Sends SIGTERM to the group, waits up to 5s, then SIGKILL if still alive.
 * Direct replacement for session-reaper's killProcess().
 *
 * @param {number} pid - Process group leader PID
 * @returns {Promise<void>}
 */
export async function killProcessGroupEscalated(pid) {
  if (!pid || pid <= 0) return;

  // Send SIGTERM to the process group
  if (!killProcessGroup(pid, 'SIGTERM')) return; // Already dead

  // Poll for up to 5 seconds
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200));
    try {
      process.kill(pid, 0); // Check if lead PID is still alive
    } catch (_) {
      return; // Dead — cleanup complete
    }
  }

  // Still alive after 5s — escalate to SIGKILL
  killProcessGroup(pid, 'SIGKILL');
}

/**
 * Kill all processes whose open files are inside a directory.
 * Uses lsof +D to enumerate PIDs, deduplicates by process group,
 * then kills each unique group.
 *
 * @param {string} dirPath - Absolute path to the directory
 * @param {object} [options]
 * @param {number} [options.timeoutMs=5000] - lsof timeout in ms
 * @returns {{ killed: number[], errors: string[] }}
 */
export function killProcessesInDirectory(dirPath, options = {}) {
  const { timeoutMs = 5000 } = options;
  const killed = [];
  const errors = [];

  // Find all PIDs with open files in the directory.
  // On macOS, lsof exits with code 1 even when it finds results (it also
  // exits 1 when there are no results). We must read stdout from the thrown
  // error rather than treating any non-zero exit as "no results".
  let pids;
  try {
    const output = execFileSync('lsof', ['+D', dirPath, '-t'], {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    pids = output.trim().split('\n').filter(Boolean).map(Number).filter(n => !isNaN(n) && n > 0);
  } catch (err) {
    // lsof exits non-zero in two cases:
    //   1. No matching files (stdout is empty) — treat as "nothing to kill"
    //   2. macOS behaviour: exits 1 even with results (stdout has PIDs)
    // Recover by parsing stdout from the error object when present.
    const stdout = (err && err.stdout) ? String(err.stdout) : '';
    pids = stdout.trim().split('\n').filter(Boolean).map(Number).filter(n => !isNaN(n) && n > 0);
    if (pids.length === 0) {
      return { killed, errors };
    }
  }

  if (pids.length === 0) return { killed, errors };

  // Deduplicate by process group to avoid killing the same group twice
  const groups = new Set();
  const pidToGroup = new Map();

  for (const pid of pids) {
    try {
      const pgidStr = execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      const pgid = parseInt(pgidStr, 10);
      if (!isNaN(pgid) && pgid > 0) {
        pidToGroup.set(pid, pgid);
        groups.add(pgid);
      } else {
        pidToGroup.set(pid, pid); // Fallback: use PID as group
        groups.add(pid);
      }
    } catch (_) {
      pidToGroup.set(pid, pid);
      groups.add(pid);
    }
  }

  // Kill each unique process group
  for (const pgid of groups) {
    try {
      process.kill(-pgid, 'SIGTERM');
      killed.push(pgid);
    } catch (err) {
      if (err.code === 'EPERM') {
        // Fall back to killing individual PIDs in this group
        for (const [pid, g] of pidToGroup) {
          if (g === pgid) {
            try {
              process.kill(pid, 'SIGTERM');
              killed.push(pid);
            } catch (_) { /* already dead */ }
          }
        }
      } else if (err.code !== 'ESRCH') {
        errors.push(`Failed to kill group ${pgid}: ${err.message}`);
      }
    }
  }

  return { killed, errors };
}
