/**
 * Process Pressure Monitor for GENTYR agent spawning.
 *
 * Peer to lib/memory-pressure.js. Memory pressure catches RAM exhaustion;
 * THIS module catches the orthogonal failure mode where the box has plenty
 * of free RAM but is saturated by orphan node processes that exhaust kernel
 * resources (pid limits, file descriptors, scheduler queues). The 2026-05-27
 * incident saw 737 orphan node processes deadlock `force_spawn_tasks` with
 * spawnSync ETIMEDOUT while RAM was still healthy — memory-pressure cannot
 * see this failure shape.
 *
 * Integrated into:
 *   - session-queue.js enqueueSession() — gate check before insert
 *   - session-queue.js spawnQueueItem() — pre-retry reaper trigger on attempt #2
 *   - hourly-automation.js force_spawn_tasks ETIMEDOUT — on-demand reap
 *
 * @module lib/process-pressure
 */

import { execFileSync } from 'child_process';
import os from 'os';

/**
 * Pressure levels mirror memory-pressure.js so callers use a single ladder:
 *   low      — under 250 node processes, spawn freely
 *   moderate — 250–399 node processes, allow but log
 *   high     — 400–599 node processes, only urgent/cto/critical spawn
 *   critical — 600+ node processes, block all but cto/critical spawns
 */
const PRESSURE_LEVELS = ['low', 'moderate', 'high', 'critical'];

const NODE_COUNT_CRITICAL = parseInt(process.env.GENTYR_NODE_COUNT_CRITICAL || '600', 10);
const NODE_COUNT_HIGH     = parseInt(process.env.GENTYR_NODE_COUNT_HIGH     || '400', 10);
const NODE_COUNT_MODERATE = parseInt(process.env.GENTYR_NODE_COUNT_MODERATE || '250', 10);

/**
 * Count node/esbuild/vitest processes on the system. Uses `ps -eo comm` which
 * is portable across macOS and Linux. Counts unique PIDs, not unique commands.
 *
 * Excludes the current process so a session checking its own pressure does not
 * double-count itself.
 *
 * @returns {{ nodeCount: number, claudeAgentCount: number, error: string|null }}
 *   `claudeAgentCount` is the subset of node processes whose command path
 *   references `.claude/` — useful for distinguishing gentyr-spawned procs
 *   from the user's editor/dev servers when reporting saturation cause.
 */
function countCandidateProcesses() {
  try {
    // Format: PID PPID COMM (with full command).
    // `args` is portable; `command` returns the same on macOS/Linux.
    const out = execFileSync('ps', ['-eo', 'pid,ppid,command'], {
      encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let nodeCount = 0;
    let claudeAgentCount = 0;
    const selfPid = process.pid;
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('PID')) continue;
      const m = trimmed.match(/^(\d+)\s+\d+\s+(.+)$/);
      if (!m) continue;
      const pid = parseInt(m[1], 10);
      const cmd = m[2];
      if (pid === selfPid) continue;
      if (!/\b(node|esbuild|vitest)\b/.test(cmd)) continue;
      nodeCount++;
      if (cmd.includes('.claude/') || cmd.includes('claude-code')) claudeAgentCount++;
    }
    return { nodeCount, claudeAgentCount, error: null };
  } catch (err) {
    return { nodeCount: 0, claudeAgentCount: 0, error: err.message };
  }
}

/**
 * Assess current process pressure level. Pure-read, no side effects.
 *
 * @returns {{ pressure: string, nodeCount: number, claudeAgentCount: number, details: string }}
 */
export function getProcessPressure() {
  const { nodeCount, claudeAgentCount, error } = countCandidateProcesses();

  if (error) {
    // Fail-open: if we can't count, assume low pressure rather than block
    // all spawning on a `ps` failure. Memory-pressure handles the same case.
    return {
      pressure: 'low',
      nodeCount: 0,
      claudeAgentCount: 0,
      details: `process count unavailable (${error}); assuming low`,
    };
  }

  let pressure = 'low';
  const reasons = [];
  if (nodeCount >= NODE_COUNT_CRITICAL) {
    pressure = 'critical';
    reasons.push(`node count ${nodeCount} >= ${NODE_COUNT_CRITICAL} critical threshold`);
  } else if (nodeCount >= NODE_COUNT_HIGH) {
    if (PRESSURE_LEVELS.indexOf('high') > PRESSURE_LEVELS.indexOf(pressure)) pressure = 'high';
    reasons.push(`node count ${nodeCount} >= ${NODE_COUNT_HIGH} high threshold`);
  } else if (nodeCount >= NODE_COUNT_MODERATE) {
    if (PRESSURE_LEVELS.indexOf('moderate') > PRESSURE_LEVELS.indexOf(pressure)) pressure = 'moderate';
    reasons.push(`node count ${nodeCount} >= ${NODE_COUNT_MODERATE} moderate threshold`);
  }

  const details = reasons.length > 0
    ? reasons.join('; ') + ` (${claudeAgentCount} are .claude/ processes)`
    : `healthy (${nodeCount} node processes, ${claudeAgentCount} are .claude/ processes)`;

  return { pressure, nodeCount, claudeAgentCount, details };
}

/**
 * Determine whether a new agent should be spawned given current process
 * pressure. Mirrors memory-pressure.shouldAllowSpawn() return shape so
 * callers can apply identical gating logic against both modules.
 *
 * Allow-priorities at critical: `cto`, `critical`.
 * Allow-priorities at high:     `cto`, `critical`, `urgent`.
 * Always allowed at moderate and low.
 *
 * @param {object} [options]
 * @param {string} [options.priority='normal'] - 'cto' | 'critical' | 'urgent' | 'normal'
 * @param {string} [options.context='unknown'] - Caller label for log lines
 * @returns {{ allowed: boolean, reason: string|null, pressure: string }}
 */
export function shouldAllowSpawn(options = {}) {
  const priority = options.priority || 'normal';
  const context = options.context || 'unknown';
  const p = getProcessPressure();

  switch (p.pressure) {
    case 'critical':
      if (priority === 'cto' || priority === 'critical') {
        return {
          allowed: true,
          reason: `[PROCESS CRITICAL] Allowing ${priority}-priority ${context} spawn despite process saturation: ${p.details}`,
          pressure: p.pressure,
        };
      }
      return {
        allowed: false,
        reason: `[PROCESS CRITICAL] Blocked ${context} spawn: ${p.details}. ` +
          `System is saturated by ${p.nodeCount} node processes. ` +
          `Each new spawn risks spawnSync ETIMEDOUT. ` +
          `Run reaper (--reap-orphans-aggressive) or wait for running agents to complete.`,
        pressure: p.pressure,
      };
    case 'high':
      if (priority === 'cto' || priority === 'critical' || priority === 'urgent') {
        return {
          allowed: true,
          reason: `[PROCESS HIGH] Allowing ${priority}-priority ${context} spawn despite high process pressure: ${p.details}`,
          pressure: p.pressure,
        };
      }
      return {
        allowed: false,
        reason: `[PROCESS HIGH] Deferred ${context} normal-priority spawn: ${p.details}. ` +
          `Only urgent/cto/critical tasks are allowed at this pressure level.`,
        pressure: p.pressure,
      };
    case 'moderate':
    default:
      return { allowed: true, reason: null, pressure: p.pressure };
  }
}

// CLI mode for ad-hoc inspection: `node lib/process-pressure.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  const out = getProcessPressure();
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}
