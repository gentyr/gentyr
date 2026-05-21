/**
 * Interactive Session Liveness Tracking
 *
 * Tracks active interactive (CTO) Claude Code sessions so the rescue/reaper
 * automation can avoid touching worktrees owned by a live operator.
 *
 * State file: .claude/state/interactive-sessions.json
 * Entry shape: { [sessionId]: { pid, ctoWorktreePath, lastHeartbeat, startedAt } }
 *
 * Heartbeat staleness threshold: 30 minutes (entries older than this with a
 * dead PID are auto-purged on read).
 *
 * SECURITY: This module is consumed by root-owned hooks. The state file
 * itself is not protected.
 */

import fs from 'fs';
import path from 'path';

const STALE_HEARTBEAT_MS = 30 * 60 * 1000; // 30 minutes

function getProjectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function getStatePath(projectDir = getProjectDir()) {
  return path.join(projectDir, '.claude', 'state', 'interactive-sessions.json');
}

function readState(statePath) {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(statePath, state) {
  const dir = path.dirname(statePath);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = statePath + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
    fs.renameSync(tmp, statePath);
    return true;
  } catch {
    return false;
  }
}

function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isEntryStale(entry, now = Date.now()) {
  if (!entry || typeof entry !== 'object') return true;
  const heartbeat = entry.lastHeartbeat ? new Date(entry.lastHeartbeat).getTime() : 0;
  if (!heartbeat || Number.isNaN(heartbeat)) return true;
  if (now - heartbeat <= STALE_HEARTBEAT_MS) return false;
  return !isPidAlive(entry.pid);
}

/**
 * Record/refresh the current interactive session's liveness.
 * Called by session-briefing.js (SessionStart) and interactive-heartbeat.js
 * (UserPromptSubmit). Idempotent — overwrites the session's entry.
 *
 * @param {string} sessionId Claude session UUID
 * @param {string|null} ctoWorktreePath The session's CTO worktree, if any
 * @param {object} opts { projectDir, pid }
 */
export function recordInteractiveLiveness(sessionId, ctoWorktreePath, opts = {}) {
  if (!sessionId) return false;
  const projectDir = opts.projectDir || getProjectDir();
  const statePath = getStatePath(projectDir);
  const state = readState(statePath);
  const now = new Date().toISOString();
  const pid = typeof opts.pid === 'number' ? opts.pid : process.ppid;
  const existing = state[sessionId] || {};
  state[sessionId] = {
    pid,
    ctoWorktreePath: ctoWorktreePath || existing.ctoWorktreePath || null,
    lastHeartbeat: now,
    startedAt: existing.startedAt || now,
  };
  // Opportunistic purge of stale entries on every write
  purgeStaleInPlace(state);
  return writeState(statePath, state);
}

/**
 * Update only the ctoWorktreePath for a session (after lockdown toggle).
 * Returns true on success.
 */
export function updateSessionWorktreePath(sessionId, ctoWorktreePath, opts = {}) {
  if (!sessionId) return false;
  const projectDir = opts.projectDir || getProjectDir();
  const statePath = getStatePath(projectDir);
  const state = readState(statePath);
  if (!state[sessionId]) {
    state[sessionId] = {
      pid: opts.pid || process.ppid,
      ctoWorktreePath: ctoWorktreePath || null,
      lastHeartbeat: new Date().toISOString(),
      startedAt: new Date().toISOString(),
    };
  } else {
    state[sessionId].ctoWorktreePath = ctoWorktreePath || null;
    state[sessionId].lastHeartbeat = new Date().toISOString();
  }
  return writeState(statePath, state);
}

/**
 * Return all sessions that are currently considered alive.
 * Auto-purges stale entries as a side effect when prune=true (default).
 *
 * @param {object} opts { projectDir, prune }
 * @returns {{ sessionId, pid, ctoWorktreePath, lastHeartbeat, startedAt }[]}
 */
export function getActiveInteractiveSessions(opts = {}) {
  const projectDir = opts.projectDir || getProjectDir();
  const statePath = getStatePath(projectDir);
  const state = readState(statePath);
  const prune = opts.prune !== false;
  const now = Date.now();
  const active = [];
  const next = {};
  for (const [sid, entry] of Object.entries(state)) {
    if (isEntryStale(entry, now)) continue;
    active.push({ sessionId: sid, ...entry });
    next[sid] = entry;
  }
  if (prune && Object.keys(next).length !== Object.keys(state).length) {
    writeState(statePath, next);
  }
  return active;
}

/**
 * Return the set of worktree paths claimed by live interactive sessions.
 * Cheap lookup helper for rescue/reaper cross-checks.
 *
 * @returns {Set<string>}
 */
export function getActiveCtoWorktreePaths(opts = {}) {
  const sessions = getActiveInteractiveSessions(opts);
  const paths = new Set();
  for (const s of sessions) {
    if (s.ctoWorktreePath) paths.add(s.ctoWorktreePath);
  }
  return paths;
}

function purgeStaleInPlace(state, now = Date.now()) {
  for (const sid of Object.keys(state)) {
    if (isEntryStale(state[sid], now)) delete state[sid];
  }
  return state;
}

/**
 * Purge stale entries from the state file and return the removed ones so
 * callers can act on them (e.g., remove orphaned worktrees).
 *
 * @returns {{ sessionId, entry }[]}
 */
export function purgeDeadSessions(opts = {}) {
  const projectDir = opts.projectDir || getProjectDir();
  const statePath = getStatePath(projectDir);
  const state = readState(statePath);
  const now = Date.now();
  const removed = [];
  const next = {};
  for (const [sid, entry] of Object.entries(state)) {
    if (isEntryStale(entry, now)) {
      removed.push({ sessionId: sid, entry });
    } else {
      next[sid] = entry;
    }
  }
  if (removed.length > 0) writeState(statePath, next);
  return removed;
}

/**
 * Read a single session's liveness entry (no staleness check).
 */
export function getInteractiveSession(sessionId, opts = {}) {
  if (!sessionId) return null;
  const projectDir = opts.projectDir || getProjectDir();
  const statePath = getStatePath(projectDir);
  const state = readState(statePath);
  return state[sessionId] || null;
}

/**
 * Remove a single session's entry (e.g., on /lockdown on cleanup).
 */
export function removeInteractiveSession(sessionId, opts = {}) {
  if (!sessionId) return false;
  const projectDir = opts.projectDir || getProjectDir();
  const statePath = getStatePath(projectDir);
  const state = readState(statePath);
  if (!state[sessionId]) return false;
  delete state[sessionId];
  return writeState(statePath, state);
}

// Test-only helper to override the stale threshold
export const __testing = { STALE_HEARTBEAT_MS, isEntryStale, isPidAlive };
