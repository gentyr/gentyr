/**
 * Usage Optimizer
 *
 * Tracks API quota utilization every 10 minutes and dynamically adjusts
 * automation spawn rates to target 90% usage at reset time.
 *
 * Called as the first step in hourly-automation.js on every 10-minute invocation.
 *
 * Process:
 * 1. Snapshot: Fetch usage from Anthropic API for all keys in api-key-rotation.json
 * 2. Trajectory: Calculate linear usage rate from recent snapshots (needs 3+)
 * 3. Adjustment: Compare projected-at-reset to 90% target, compute factor
 *
 * @version 1.0.0
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getConfigPath, getDefaults } from './config-reader.js';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const ROTATION_STATE_PATH = path.join(PROJECT_DIR, '.claude', 'api-key-rotation.json');
const SNAPSHOTS_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'usage-snapshots.json');
const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const ANTHROPIC_API_URL = 'https://api.anthropic.com/api/oauth/usage';
const ANTHROPIC_BETA_HEADER = 'oauth-2025-04-20';

const TARGET_UTILIZATION = 0.90;
const MAX_FACTOR = 2.0;
const MIN_FACTOR = 0.5;
const MAX_CHANGE_PER_CYCLE = 0.10; // ±10% per cycle
const SNAPSHOT_RETENTION_DAYS = 7;
const MIN_SNAPSHOTS_FOR_TRAJECTORY = 3;

/**
 * Main entry point - run the usage optimizer.
 * Designed to be cheap and fast (one API call + math).
 *
 * @param {function} [logFn] - Optional log function (default: console.log)
 * @returns {Promise<{success: boolean, snapshotTaken: boolean, adjustmentMade: boolean, error?: string}>}
 */
export async function runUsageOptimizer(logFn) {
  const log = logFn || console.log;

  try {
    // Step 1: Collect usage snapshot
    const snapshot = await collectSnapshot(log);
    if (!snapshot) {
      return { success: true, snapshotTaken: false, adjustmentMade: false };
    }

    // Step 2: Store snapshot
    storeSnapshot(snapshot, log);

    // Step 3: Calculate trajectory and adjust (if enough data)
    const adjusted = calculateAndAdjust(log);

    return { success: true, snapshotTaken: true, adjustmentMade: adjusted };
  } catch (err) {
    log(`Usage optimizer error: ${err.message}`);
    return { success: false, snapshotTaken: false, adjustmentMade: false, error: err.message };
  }
}

/**
 * Fetch usage data from all tracked API keys.
 * Returns null if no keys available or API unreachable.
 */
async function collectSnapshot(log) {
  const keys = getApiKeys();
  if (keys.length === 0) {
    log('Usage optimizer: No API keys found, skipping snapshot.');
    return null;
  }

  const ts = Date.now();
  const keyData = {};

  for (const key of keys) {
    try {
      const usage = await fetchUsage(key.accessToken);
      if (usage) {
        keyData[key.id] = {
          '5h': usage.fiveHour.utilization,
          '5h_reset': usage.fiveHour.resetsAt,
          '7d': usage.sevenDay.utilization,
          '7d_reset': usage.sevenDay.resetsAt,
        };
      }
    } catch (err) {
      log(`Usage optimizer: Failed to fetch usage for key ${key.id}: ${err.message}`);
    }
  }

  if (Object.keys(keyData).length === 0) {
    log('Usage optimizer: No usage data retrieved, skipping snapshot.');
    return null;
  }

  return { ts, keys: keyData };
}

/**
 * Get API keys from rotation state or credentials file.
 * Returns array of { id, accessToken }.
 */
function getApiKeys() {
  const keys = [];

  // Try rotation state first (multiple keys)
  if (fs.existsSync(ROTATION_STATE_PATH)) {
    try {
      const state = JSON.parse(fs.readFileSync(ROTATION_STATE_PATH, 'utf8'));
      if (state && state.keys && typeof state.keys === 'object') {
        for (const [id, data] of Object.entries(state.keys)) {
          if (data.accessToken) {
            keys.push({ id: id.substring(0, 8), accessToken: data.accessToken });
          }
        }
      }
    } catch (err) {
      console.error(`[usage-optimizer] Failed to read rotation state: ${err.message}`);
    }
  }

  // Fall back to single credentials file
  if (keys.length === 0 && fs.existsSync(CREDENTIALS_PATH)) {
    try {
      const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
      if (creds?.claudeAiOauth?.accessToken) {
        keys.push({ id: 'default', accessToken: creds.claudeAiOauth.accessToken });
      }
    } catch (err) {
      console.error(`[usage-optimizer] Failed to read credentials: ${err.message}`);
    }
  }

  return keys;
}

/**
 * Fetch usage from Anthropic API for a single key.
 * Returns { fiveHour: { utilization, resetsAt }, sevenDay: { utilization, resetsAt } } or null.
 */
async function fetchUsage(accessToken) {
  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'claude-code/2.1.14',
      'anthropic-beta': ANTHROPIC_BETA_HEADER,
    },
  });

  if (!response.ok) {
    return null;
  }

  const data = await response.json();

  return {
    fiveHour: {
      utilization: data.five_hour?.utilization ?? 0,
      resetsAt: data.five_hour?.resets_at ?? null,
    },
    sevenDay: {
      utilization: data.seven_day?.utilization ?? 0,
      resetsAt: data.seven_day?.resets_at ?? null,
    },
  };
}

/**
 * Store a snapshot and prune old entries.
 */
function storeSnapshot(snapshot, log) {
  let data = { snapshots: [] };

  if (fs.existsSync(SNAPSHOTS_PATH)) {
    try {
      data = JSON.parse(fs.readFileSync(SNAPSHOTS_PATH, 'utf8'));
      if (!data || !Array.isArray(data.snapshots)) {
        data = { snapshots: [] };
      }
    } catch {
      data = { snapshots: [] };
    }
  }

  data.snapshots.push(snapshot);

  // Prune entries older than retention period
  const cutoff = Date.now() - (SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  data.snapshots = data.snapshots.filter(s => s.ts > cutoff);

  try {
    fs.writeFileSync(SNAPSHOTS_PATH, JSON.stringify(data, null, 2));
  } catch (err) {
    log(`Usage optimizer: Failed to write snapshots: ${err.message}`);
  }
}

/**
 * Calculate trajectory and adjust cooldowns.
 * Returns true if an adjustment was made.
 */
function calculateAndAdjust(log) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(SNAPSHOTS_PATH, 'utf8'));
  } catch {
    return false;
  }

  if (!data || !data.snapshots || data.snapshots.length < MIN_SNAPSHOTS_FOR_TRAJECTORY) {
    log(`Usage optimizer: Only ${data?.snapshots?.length ?? 0} snapshots, need ${MIN_SNAPSHOTS_FOR_TRAJECTORY}. Skipping adjustment.`);
    return false;
  }

  // Get the most relevant metrics (aggregate across keys)
  const latest = data.snapshots[data.snapshots.length - 1];
  const earliest = data.snapshots[Math.max(0, data.snapshots.length - 30)]; // Use up to last 30 snapshots

  const hoursBetween = (latest.ts - earliest.ts) / (1000 * 60 * 60);
  if (hoursBetween < 0.15) { // Less than ~10 minutes of data
    log('Usage optimizer: Not enough time span for trajectory. Skipping.');
    return false;
  }

  // Calculate aggregate metrics across all keys
  const aggregate = calculateAggregate(latest, earliest, hoursBetween);
  if (!aggregate) {
    log('Usage optimizer: Could not calculate aggregate metrics.');
    return false;
  }

  // Determine constraining metric
  const projected5h = aggregate.current5h + (aggregate.rate5h * aggregate.hoursUntil5hReset);
  const projected7d = aggregate.current7d + (aggregate.rate7d * aggregate.hoursUntil7dReset);
  const constraining = projected5h > projected7d ? '5h' : '7d';
  const projectedAtReset = Math.max(projected5h, projected7d);

  // Read current config
  const configPath = getConfigPath();
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    log('Usage optimizer: Config file unreadable, skipping adjustment.');
    return false;
  }

  const currentFactor = config.adjustment?.factor ?? 1.0;
  const currentUsage = constraining === '5h' ? aggregate.current5h : aggregate.current7d;
  const currentRate = constraining === '5h' ? aggregate.rate5h : aggregate.rate7d;
  const hoursUntilReset = constraining === '5h' ? aggregate.hoursUntil5hReset : aggregate.hoursUntil7dReset;

  // Edge case: already at or above target
  if (currentUsage >= TARGET_UTILIZATION) {
    // Never speed up if already near cap - clamp factor to <= 1.0
    const newFactor = Math.min(currentFactor, 1.0);
    if (newFactor !== currentFactor) {
      applyFactor(config, newFactor, constraining, projectedAtReset, log);
      return true;
    }
    log(`Usage optimizer: Already at ${Math.round(currentUsage * 100)}% usage. Holding steady.`);
    return false;
  }

  // Edge case: rate is zero or negative (usage flat/decreasing)
  if (currentRate <= 0) {
    // Conservatively speed up toward 2.0
    const newFactor = Math.min(currentFactor * 1.05, MAX_FACTOR);
    if (Math.abs(newFactor - currentFactor) > 0.001) {
      applyFactor(config, newFactor, constraining, projectedAtReset, log);
      return true;
    }
    return false;
  }

  // Normal case: calculate desired rate to hit target at reset
  const desiredRate = (TARGET_UTILIZATION - currentUsage) / hoursUntilReset;
  const rawRatio = desiredRate / currentRate;

  // Conservative bounds: max ±10% per cycle
  const clamped = Math.max(1.0 - MAX_CHANGE_PER_CYCLE, Math.min(1.0 + MAX_CHANGE_PER_CYCLE, rawRatio));
  let newFactor = currentFactor * clamped;

  // Overall bounds
  newFactor = Math.max(MIN_FACTOR, Math.min(MAX_FACTOR, newFactor));

  // Only apply if meaningful change
  if (Math.abs(newFactor - currentFactor) < 0.01) {
    log(`Usage optimizer: Factor unchanged (${currentFactor.toFixed(2)}). On track for ${Math.round(projectedAtReset * 100)}% at reset.`);
    return false;
  }

  applyFactor(config, newFactor, constraining, projectedAtReset, log);
  return true;
}

/**
 * Calculate aggregate metrics across all keys in a snapshot pair.
 * Only compares keys present in BOTH snapshots to avoid skewed rates.
 */
function calculateAggregate(latest, earliest, hoursBetween) {
  const latestEntries = Object.entries(latest.keys);
  if (latestEntries.length === 0) return null;

  // Find common keys between latest and earliest snapshots
  const commonKeyIds = latestEntries
    .map(([id]) => id)
    .filter(id => id in earliest.keys);

  // Use common keys for rate calculation, all latest keys for current state
  let sum5h = 0, sum7d = 0;
  let resetAt5h = null, resetAt7d = null;

  for (const [, k] of latestEntries) {
    sum5h += k['5h'] ?? 0;
    sum7d += k['7d'] ?? 0;
    if (k['5h_reset']) resetAt5h = k['5h_reset'];
    if (k['7d_reset']) resetAt7d = k['7d_reset'];
  }

  const numKeys = latestEntries.length;
  const current5h = sum5h / numKeys;
  const current7d = sum7d / numKeys;

  // Calculate rate only from keys present in both snapshots
  let rate5h = 0, rate7d = 0;
  if (commonKeyIds.length > 0) {
    let latestCommon5h = 0, latestCommon7d = 0;
    let earliestCommon5h = 0, earliestCommon7d = 0;

    for (const id of commonKeyIds) {
      latestCommon5h += latest.keys[id]['5h'] ?? 0;
      latestCommon7d += latest.keys[id]['7d'] ?? 0;
      earliestCommon5h += earliest.keys[id]['5h'] ?? 0;
      earliestCommon7d += earliest.keys[id]['7d'] ?? 0;
    }

    const avg5hNow = latestCommon5h / commonKeyIds.length;
    const avg7dNow = latestCommon7d / commonKeyIds.length;
    const avg5hPrev = earliestCommon5h / commonKeyIds.length;
    const avg7dPrev = earliestCommon7d / commonKeyIds.length;

    rate5h = (avg5hNow - avg5hPrev) / hoursBetween;
    rate7d = (avg7dNow - avg7dPrev) / hoursBetween;
  }

  // Calculate hours until reset
  const now = Date.now();
  let hoursUntil5hReset = 5; // default fallback
  let hoursUntil7dReset = 168; // default fallback (7 days)

  if (resetAt5h) {
    const resetTime = new Date(resetAt5h).getTime();
    hoursUntil5hReset = Math.max(0.1, (resetTime - now) / (1000 * 60 * 60));
  }

  if (resetAt7d) {
    const resetTime = new Date(resetAt7d).getTime();
    hoursUntil7dReset = Math.max(0.1, (resetTime - now) / (1000 * 60 * 60));
  }

  return { current5h, current7d, rate5h, rate7d, hoursUntil5hReset, hoursUntil7dReset };
}

/**
 * Apply a new factor to the config, recalculating all effective cooldowns.
 */
function applyFactor(config, newFactor, constraining, projectedAtReset, log) {
  const previousFactor = config.adjustment?.factor ?? 1.0;
  const defaults = config.defaults || getDefaults();

  // Calculate effective cooldowns: higher factor = shorter cooldowns = more activity
  const effective = {};
  for (const [key, defaultVal] of Object.entries(defaults)) {
    effective[key] = Math.round(defaultVal / newFactor);
  }

  config.effective = effective;
  config.adjustment = {
    factor: Math.round(newFactor * 1000) / 1000, // 3 decimal places
    last_updated: new Date().toISOString(),
    constraining_metric: constraining,
    projected_at_reset: Math.round(projectedAtReset * 1000) / 1000,
  };

  const configPath = getConfigPath();
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    log(`Usage optimizer: Factor ${newFactor.toFixed(3)} (was ${previousFactor.toFixed(3)}). ` +
        `Constraining: ${constraining}. Projected at reset: ${Math.round(projectedAtReset * 100)}%.`);
  } catch (err) {
    log(`Usage optimizer: Failed to write config: ${err.message}`);
  }
}
