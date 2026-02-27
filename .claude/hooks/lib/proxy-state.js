/**
 * Shared helper for reading the global proxy-disabled state.
 *
 * State file: ~/.claude/proxy-disabled.json
 * Format: { disabled: boolean, timestamp?: string }
 *
 * Used by all spawn helpers (hourly-automation, urgent-task-spawner,
 * task-gate-spawner, session-reviver) to conditionally skip HTTPS_PROXY
 * injection when the proxy has been disabled via `npx gentyr proxy disable`.
 *
 * @module lib/proxy-state
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const STATE_PATH = path.join(os.homedir(), '.claude', 'proxy-disabled.json');
const CACHE_TTL_MS = 30_000; // 30 seconds

let _cached = null;
let _cachedAt = 0;

/**
 * Check whether the rotation proxy has been disabled globally.
 * Result is cached for 30 seconds to avoid repeated filesystem reads.
 *
 * @returns {boolean} true if proxy is disabled
 */
export function isProxyDisabled() {
  const now = Date.now();
  if (_cached !== null && now - _cachedAt < CACHE_TTL_MS) return _cached;

  try {
    const data = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    _cached = data.disabled === true;
  } catch {
    _cached = false; // missing or corrupt file = enabled (default)
  }
  _cachedAt = now;
  return _cached;
}

/**
 * Write proxy-disabled state to the global state file.
 *
 * @param {boolean} disabled
 */
export function writeProxyState(disabled) {
  const dir = path.dirname(STATE_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify({
    disabled,
    timestamp: new Date().toISOString(),
  }, null, 2) + '\n');
  // Bust the cache
  _cached = disabled;
  _cachedAt = Date.now();
}

/**
 * Read the raw proxy-disabled state (uncached).
 *
 * @returns {{ disabled: boolean, timestamp?: string }}
 */
export function readProxyState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { disabled: false };
  }
}

export { STATE_PATH };
