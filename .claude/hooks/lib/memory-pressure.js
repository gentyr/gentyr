/**
 * Memory Pressure Monitor for GENTYR agent spawning.
 *
 * Checks system memory and node process count to prevent spawning
 * agents when the system is under memory pressure. Each Claude agent
 * session spawns ~30 MCP server processes at ~40-60MB each, consuming
 * ~1.4 GB per agent. On a 24 GB machine, 7+ agents will cause the
 * system to seize up.
 *
 * Integrated into:
 *   - urgent-task-spawner.js (evaluateQuotaGating)
 *   - revival-daemon.js (hasQuotaHeadroom)
 *   - stop-continue-hook.js (inlineRevive)
 *   - session-reviver.js (reviveDeadSessions)
 *
 * @module lib/memory-pressure
 */

import { execSync } from 'child_process';
import os from 'os';
import { debugLog } from './debug-log.js';

/**
 * Pressure levels:
 *   low      — plenty of headroom, spawn freely
 *   moderate — getting tight, limit concurrent agents
 *   high     — approaching danger zone, only urgent tasks
 *   critical — system will seize up, block all spawning
 */
const PRESSURE_LEVELS = ['low', 'moderate', 'high', 'critical'];

// Thresholds (configurable via env for tuning)
const FREE_MEM_CRITICAL_MB = parseInt(process.env.GENTYR_MEM_CRITICAL_MB || '512', 10);
const FREE_MEM_HIGH_MB = parseInt(process.env.GENTYR_MEM_HIGH_MB || '1024', 10);
const FREE_MEM_MODERATE_MB = parseInt(process.env.GENTYR_MEM_MODERATE_MB || '2048', 10);
const NODE_RSS_CRITICAL_MB = parseInt(process.env.GENTYR_NODE_RSS_CRITICAL_MB || '16384', 10);
const NODE_RSS_HIGH_MB = parseInt(process.env.GENTYR_NODE_RSS_HIGH_MB || '12288', 10);
const MAX_AGENTS_MODERATE = parseInt(process.env.GENTYR_MAX_AGENTS_MODERATE || '5', 10);
const MAX_AGENTS_HIGH = parseInt(process.env.GENTYR_MAX_AGENTS_HIGH || '3', 10);

/**
 * Get free memory in MB, platform-aware.
 * macOS: uses vm_stat (pages * page_size)
 * Linux: reads /proc/meminfo
 */
function getFreeMem() {
  const platform = os.platform();
  try {
    if (platform === 'darwin') {
      const vmstat = execSync('vm_stat', { encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
      const pageSize = 16384; // Apple Silicon default
      // Try to get actual page size
      let actualPageSize = pageSize;
      try {
        const ps = execSync('pagesize', { encoding: 'utf8', timeout: 2000, stdio: 'pipe' }).trim();
        actualPageSize = parseInt(ps, 10) || pageSize;
      } catch (err) {
        console.error('[memory-pressure] Warning:', err.message);
        /* use default */
      }

      let freePages = 0;
      const freeMatch = vmstat.match(/Pages free:\s+(\d+)/);
      const inactiveMatch = vmstat.match(/Pages inactive:\s+(\d+)/);
      const specMatch = vmstat.match(/Pages speculative:\s+(\d+)/);
      const purgeableMatch = vmstat.match(/Pages purgeable:\s+(\d+)/);
      if (freeMatch) freePages += parseInt(freeMatch[1], 10);
      // Include speculative pages (macOS treats them as effectively free)
      if (specMatch) freePages += parseInt(specMatch[1], 10);
      // Include inactive pages — macOS aggressively caches file data here,
      // but these pages are instantly reclaimable under memory pressure.
      // Without this, a 24 GB machine with 8 GB inactive reads as "critical"
      // at 182 MB free. Linux's MemAvailable includes the equivalent.
      if (inactiveMatch) freePages += parseInt(inactiveMatch[1], 10);
      // Include purgeable pages (part of active but can be discarded instantly)
      if (purgeableMatch) freePages += parseInt(purgeableMatch[1], 10);

      return Math.round((freePages * actualPageSize) / (1024 * 1024));
    } else {
      // Linux: use /proc/meminfo MemAvailable (most accurate)
      const meminfo = execSync('cat /proc/meminfo', { encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
      const availMatch = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/);
      if (availMatch) {
        return Math.round(parseInt(availMatch[1], 10) / 1024);
      }
      // Fallback to MemFree + Buffers + Cached
      let freeMB = 0;
      const freeMatch = meminfo.match(/MemFree:\s+(\d+)\s+kB/);
      const buffersMatch = meminfo.match(/Buffers:\s+(\d+)\s+kB/);
      const cachedMatch = meminfo.match(/Cached:\s+(\d+)\s+kB/);
      if (freeMatch) freeMB += parseInt(freeMatch[1], 10);
      if (buffersMatch) freeMB += parseInt(buffersMatch[1], 10);
      if (cachedMatch) freeMB += parseInt(cachedMatch[1], 10);
      return Math.round(freeMB / 1024);
    }
  } catch (err) {
    console.error('[memory-pressure] Warning:', err.message);
    // Fallback to Node.js os.freemem() (less accurate on macOS)
    return Math.round(os.freemem() / (1024 * 1024));
  }
}

/**
 * Get total RSS of all node processes in MB.
 * Uses `ps` which is available on both macOS and Linux.
 */
function getNodeProcessStats() {
  try {
    const result = execSync(
      "ps -eo rss,comm 2>/dev/null | grep -i node | awk '{sum += $1; count++} END {print sum/1024, count}'",
      { encoding: 'utf8', timeout: 5000, stdio: 'pipe' }
    ).trim();
    const parts = result.split(/\s+/);
    return {
      totalRssMB: Math.round(parseFloat(parts[0]) || 0),
      processCount: parseInt(parts[1], 10) || 0,
    };
  } catch (err) {
    console.error('[memory-pressure] Warning:', err.message);
    return { totalRssMB: 0, processCount: 0 };
  }
}


/**
 * Assess current memory pressure level.
 *
 * @returns {{ pressure: string, freeMB: number, nodeRssMB: number, nodeProcessCount: number, details: string }}
 */
export function getMemoryPressure() {
  const freeMB = getFreeMem();
  const totalMB = Math.round(os.totalmem() / (1024 * 1024));
  const { totalRssMB: nodeRssMB, processCount: nodeProcessCount } = getNodeProcessStats();

  let pressure = 'low';
  const reasons = [];

  // Check free memory
  if (freeMB < FREE_MEM_CRITICAL_MB) {
    pressure = 'critical';
    reasons.push(`free RAM ${freeMB}MB < ${FREE_MEM_CRITICAL_MB}MB critical threshold`);
  } else if (freeMB < FREE_MEM_HIGH_MB) {
    if (PRESSURE_LEVELS.indexOf('high') > PRESSURE_LEVELS.indexOf(pressure)) pressure = 'high';
    reasons.push(`free RAM ${freeMB}MB < ${FREE_MEM_HIGH_MB}MB high threshold`);
  } else if (freeMB < FREE_MEM_MODERATE_MB) {
    if (PRESSURE_LEVELS.indexOf('moderate') > PRESSURE_LEVELS.indexOf(pressure)) pressure = 'moderate';
    reasons.push(`free RAM ${freeMB}MB < ${FREE_MEM_MODERATE_MB}MB moderate threshold`);
  }

  // Check total node RSS
  if (nodeRssMB > NODE_RSS_CRITICAL_MB) {
    if (PRESSURE_LEVELS.indexOf('critical') > PRESSURE_LEVELS.indexOf(pressure)) pressure = 'critical';
    reasons.push(`node RSS ${nodeRssMB}MB > ${NODE_RSS_CRITICAL_MB}MB critical threshold`);
  } else if (nodeRssMB > NODE_RSS_HIGH_MB) {
    if (PRESSURE_LEVELS.indexOf('high') > PRESSURE_LEVELS.indexOf(pressure)) pressure = 'high';
    reasons.push(`node RSS ${nodeRssMB}MB > ${NODE_RSS_HIGH_MB}MB high threshold`);
  }

  const details = reasons.length > 0
    ? reasons.join('; ')
    : `healthy (${freeMB}MB free / ${totalMB}MB total, ${nodeRssMB}MB node RSS across ${nodeProcessCount} processes)`;

  return { pressure, freeMB, totalMB, nodeRssMB, nodeProcessCount, details };
}

/**
 * Determine whether a new agent should be spawned given current memory pressure.
 *
 * @param {object} [options]
 * @param {string} [options.priority='normal'] - Task priority ('urgent' or 'normal')
 * @param {string} [options.context='unknown'] - Caller context for logging (e.g., 'task-spawner', 'revival-daemon')
 * @returns {{ allowed: boolean, reason: string, pressure: string }}
 */
export function shouldAllowSpawn(options = {}) {
  const priority = options.priority || 'normal';
  const context = options.context || 'unknown';

  const mem = getMemoryPressure();

  switch (mem.pressure) {
    case 'critical':
      // CTO and critical-priority tasks are always allowed — persistent monitor revival uses critical priority
      if (priority === 'cto' || priority === 'critical') {
        debugLog('memory-pressure', 'pressure_check', {
          pressure: mem.pressure, freeMB: mem.freeMB, nodeRssMB: mem.nodeRssMB,
          nodeProcessCount: mem.nodeProcessCount, priority, context, allowed: true,
        }, 'info');
        return {
          allowed: true,
          reason: `[MEMORY CRITICAL] Allowing ${priority}-priority ${context} spawn despite critical memory pressure: ${mem.details}`,
          pressure: mem.pressure,
        };
      }
      // Block all other spawning — system will freeze
      debugLog('memory-pressure', 'pressure_check', {
        pressure: mem.pressure, freeMB: mem.freeMB, nodeRssMB: mem.nodeRssMB,
        nodeProcessCount: mem.nodeProcessCount, priority, context, allowed: false,
      }, 'info');
      return {
        allowed: false,
        reason: `[MEMORY CRITICAL] Blocked ${context} spawn: ${mem.details}. ` +
          `Each new agent uses ~1.4 GB (30 MCP servers). ` +
          `System has only ${mem.freeMB}MB free RAM with ${mem.nodeRssMB}MB used by ${mem.nodeProcessCount} node processes. ` +
          `Wait for running agents to complete or manually kill agents to free memory.`,
        pressure: mem.pressure,
      };

    case 'high':
      if (priority !== 'urgent' && priority !== 'cto' && priority !== 'critical') {
        debugLog('memory-pressure', 'pressure_check', {
          pressure: mem.pressure, freeMB: mem.freeMB, nodeRssMB: mem.nodeRssMB,
          nodeProcessCount: mem.nodeProcessCount, priority, context, allowed: false,
        }, 'info');
        return {
          allowed: false,
          reason: `[MEMORY HIGH] Deferred ${context} normal-priority spawn: ${mem.details}. ` +
            `Only urgent/cto/critical tasks are allowed when memory pressure is high. ` +
            `${mem.freeMB}MB free, ${mem.nodeRssMB}MB node RSS across ${mem.nodeProcessCount} processes.`,
          pressure: mem.pressure,
        };
      }
      // Urgent, CTO, and critical tasks still allowed in high pressure
      debugLog('memory-pressure', 'pressure_check', {
        pressure: mem.pressure, freeMB: mem.freeMB, nodeRssMB: mem.nodeRssMB,
        nodeProcessCount: mem.nodeProcessCount, priority, context, allowed: true,
      }, 'debug');
      return {
        allowed: true,
        reason: `[MEMORY HIGH] Allowing ${priority} ${context} spawn despite high memory pressure: ${mem.details}`,
        pressure: mem.pressure,
      };

    case 'moderate':
      // Allow but warn — the quota gating agent-count check will further limit
      debugLog('memory-pressure', 'pressure_check', {
        pressure: mem.pressure, freeMB: mem.freeMB, nodeRssMB: mem.nodeRssMB,
        nodeProcessCount: mem.nodeProcessCount, priority, context, allowed: true,
      }, 'debug');
      return {
        allowed: true,
        reason: `[MEMORY MODERATE] Allowing ${context} spawn with caution: ${mem.details}`,
        pressure: mem.pressure,
      };

    default:
      debugLog('memory-pressure', 'pressure_check', {
        pressure: mem.pressure, freeMB: mem.freeMB, nodeRssMB: mem.nodeRssMB,
        nodeProcessCount: mem.nodeProcessCount, priority, context, allowed: true,
      }, 'debug');
      return {
        allowed: true,
        reason: null,
        pressure: mem.pressure,
      };
  }
}
