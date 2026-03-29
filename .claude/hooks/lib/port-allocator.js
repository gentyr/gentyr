/**
 * Port Allocator for Worktree Isolation
 *
 * Assigns a port block per worktree to prevent port collisions between
 * concurrent dev servers. Main tree (port 3000) is never allocated.
 *
 * State: .claude/state/port-allocations.json
 * Base ports: 3100, 3200, 3300... (increment by 100)
 * Max 50 worktrees.
 *
 * Uses O_EXCL lockfile to prevent TOCTOU races on concurrent allocation.
 *
 * @module lib/port-allocator
 */

import fs from 'fs';
import path from 'path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'port-allocations.json');
const LOCK_PATH = STATE_PATH + '.lock';

const BASE_PORT_START = 3100;
const PORT_BLOCK_SIZE = 100;
const MAX_WORKTREES = 50;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 30000;

/**
 * Acquire an exclusive lockfile using O_EXCL (atomic create-or-fail).
 * Spins with backoff until acquired or timeout.
 */
function acquireLock() {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let delay = 10;

  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(LOCK_PATH, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      // Check for stale lock (process died without cleanup)
      try {
        const stat = fs.statSync(LOCK_PATH);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(LOCK_PATH);
          continue; // Retry immediately after removing stale lock
        }
      } catch {
        // Lock disappeared between EEXIST and stat — retry
        continue;
      }

      // Backoff
      const jitter = Math.random() * delay;
      const sleepMs = delay + jitter;
      const sleepEnd = Date.now() + sleepMs;
      while (Date.now() < sleepEnd) { /* spin */ }
      delay = Math.min(delay * 2, 200);
    }
  }

  throw new Error('Port allocator: could not acquire lock within timeout');
}

/**
 * Release the lockfile.
 */
function releaseLock() {
  try {
    fs.unlinkSync(LOCK_PATH);
  } catch {
    // Lock already removed — non-fatal
  }
}

/**
 * Load allocations from disk.
 * @returns {Record<string, { basePort: number, allocatedAt: string }>}
 */
function loadAllocations() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    }
  } catch {
    // Corrupt file — start fresh
  }
  return {};
}

/**
 * Save allocations to disk atomically (tmp + rename).
 * @param {Record<string, { basePort: number, allocatedAt: string }>} allocations
 */
function saveAllocations(allocations) {
  const dir = path.dirname(STATE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = STATE_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(allocations, null, 2) + '\n');
  fs.renameSync(tmpPath, STATE_PATH);
}

/**
 * Allocate a port block for a worktree.
 * Idempotent: same worktree always gets the same block.
 * Thread-safe: uses O_EXCL lockfile to prevent concurrent allocation races.
 *
 * @param {string} worktreePath - Absolute path to the worktree
 * @returns {{ basePort: number, webPort: number, backendPort: number, bridgePort: number }}
 */
export function allocatePortBlock(worktreePath) {
  acquireLock();
  try {
    const allocations = loadAllocations();

    // Idempotent: return existing allocation
    if (allocations[worktreePath]) {
      const base = allocations[worktreePath].basePort;
      return { basePort: base, webPort: base, backendPort: base + 1, bridgePort: base + 2 };
    }

    // Find allocated base ports
    const usedPorts = new Set(Object.values(allocations).map(a => a.basePort));

    // Find next available block
    let basePort = BASE_PORT_START;
    let attempts = 0;
    while (usedPorts.has(basePort) && attempts < MAX_WORKTREES) {
      basePort += PORT_BLOCK_SIZE;
      attempts++;
    }

    if (attempts >= MAX_WORKTREES) {
      throw new Error(`Port allocator: exceeded max ${MAX_WORKTREES} worktrees`);
    }

    allocations[worktreePath] = { basePort, allocatedAt: new Date().toISOString() };
    saveAllocations(allocations);

    return { basePort, webPort: basePort, backendPort: basePort + 1, bridgePort: basePort + 2 };
  } finally {
    releaseLock();
  }
}

/**
 * Release a port block when a worktree is removed.
 *
 * @param {string} worktreePath - Absolute path to the worktree
 */
export function releasePortBlock(worktreePath) {
  acquireLock();
  try {
    const allocations = loadAllocations();
    if (allocations[worktreePath]) {
      delete allocations[worktreePath];
      saveAllocations(allocations);
    }
  } finally {
    releaseLock();
  }
}

/**
 * Get the port block for a worktree, or null if not allocated.
 * Read-only — no lock needed.
 *
 * @param {string} worktreePath - Absolute path to the worktree
 * @returns {{ basePort: number, webPort: number, backendPort: number, bridgePort: number } | null}
 */
export function getPortBlock(worktreePath) {
  const allocations = loadAllocations();
  if (!allocations[worktreePath]) return null;
  const base = allocations[worktreePath].basePort;
  return { basePort: base, webPort: base, backendPort: base + 1, bridgePort: base + 2 };
}

/**
 * Remove port allocations for worktree paths that no longer exist on disk.
 * Safety net for cleanup paths that bypass removeWorktree() (e.g., manual
 * `git worktree remove`, project-manager direct cleanup, hourly automation).
 *
 * @returns {number} Number of stale allocations removed
 */
export function cleanupStaleAllocations() {
  acquireLock();
  try {
    const allocations = loadAllocations();
    const paths = Object.keys(allocations);
    let removed = 0;

    for (const worktreePath of paths) {
      if (!fs.existsSync(worktreePath)) {
        delete allocations[worktreePath];
        removed++;
      }
    }

    if (removed > 0) {
      saveAllocations(allocations);
    }
    return removed;
  } finally {
    releaseLock();
  }
}

export default { allocatePortBlock, releasePortBlock, getPortBlock, cleanupStaleAllocations };
