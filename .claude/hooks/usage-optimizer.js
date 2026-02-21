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
import { execFileSync } from 'child_process';
import { getConfigPath, getDefaults } from './config-reader.js';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const ROTATION_STATE_PATH = path.join(os.homedir(), '.claude', 'api-key-rotation.json');
const OLD_PROJECT_ROTATION_PATH = path.join(PROJECT_DIR, '.claude', 'api-key-rotation.json');
const SNAPSHOTS_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'usage-snapshots.json');
const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const ANTHROPIC_API_URL = 'https://api.anthropic.com/api/oauth/usage';
const ANTHROPIC_BETA_HEADER = 'oauth-2025-04-20';

const TARGET_UTILIZATION = 0.90;
const MAX_FACTOR = 20.0;  // up to 20x speedup (MIN_EFFECTIVE_MINUTES is the real ceiling)
const MIN_FACTOR = 0.05;  // up to 20x slowdown
const MAX_CHANGE_PER_CYCLE = 0.10; // ±10% per cycle
const SNAPSHOT_RETENTION_DAYS = 7;
const MIN_SNAPSHOTS_FOR_TRAJECTORY = 3;
const MIN_EFFECTIVE_MINUTES = 5; // Floor: no cooldown can go below 5 minutes
const MAX_COOLDOWN_MINUTES = {
  production_health_monitor: 120,  // 2h max (default 60) — never throttle production health beyond 2h
  staging_health_monitor: 360,     // 6h max (default 180) — cap staging health throttling
  triage_check: 15,                // 15min max (default 5) — keep triage responsive
};
const SINGLE_KEY_WARNING_THRESHOLD = 0.80; // Warn when any key exceeds 80%
const RESET_BOUNDARY_DROP_THRESHOLD = 0.30; // Detect reset when 5h drops >30pp
const MIN_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;  // 5 min — throttle between snapshots
const EMA_WINDOW_MS = 2 * 60 * 60 * 1000;        // 2 hours — time window for EMA
const EMA_MIN_INTERVAL_MS = 5 * 60 * 1000;        // 5 min — dedup interval for EMA input
const MIN_HOURS_DELTA = 0.05;                      // 3 min — floor for EMA interval pairs

/**
 * Revert overdrive state, restoring previous effective values and factor.
 */
function revertOverdrive(config, log) {
  const prev = config.overdrive.previous_state;
  if (prev?.effective) {
    config.effective = prev.effective;
  }
  if (prev?.factor !== undefined) {
    const restoredFactor = Math.max(MIN_FACTOR, Math.min(MAX_FACTOR, prev.factor));
    config.adjustment = config.adjustment || {};
    config.adjustment.factor = restoredFactor;
    config.adjustment.last_updated = new Date().toISOString();
    config.adjustment.direction = 'overdrive-reverted';
  }
  config.overdrive.active = false;

  const configPath = getConfigPath();
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  log(`Usage optimizer: Overdrive expired, reverted to previous state (factor: ${prev?.factor ?? 1.0})`);
}

/**
 * Get the timestamp of the most recent snapshot from the snapshots file.
 * Returns null if no snapshots exist or file is unreadable.
 */
function getLastSnapshotTimestamp() {
  try {
    if (!fs.existsSync(SNAPSHOTS_PATH)) return null;
    const data = JSON.parse(fs.readFileSync(SNAPSHOTS_PATH, 'utf8'));
    if (!data || !Array.isArray(data.snapshots) || data.snapshots.length === 0) return null;
    return data.snapshots[data.snapshots.length - 1]?.ts || null;
  } catch {
    return null;
  }
}

/**
 * Select time-based snapshots from an array, deduplicating by minimum interval.
 * Walks backward from the most recent snapshot, only including entries at least
 * minIntervalMs apart, stopping when windowMs is exceeded.
 *
 * @param {Array} snapshots - All snapshots (must have .ts)
 * @param {number} windowMs - Maximum time window from most recent snapshot
 * @param {number} minIntervalMs - Minimum interval between selected snapshots
 * @returns {Array} Selected snapshots in chronological order
 */
function selectTimeBasedSnapshots(snapshots, windowMs, minIntervalMs) {
  if (!snapshots || snapshots.length === 0) return [];

  const latest = snapshots[snapshots.length - 1];
  const windowStart = latest.ts - windowMs;
  const selected = [latest];
  let lastSelectedTs = latest.ts;

  for (let i = snapshots.length - 2; i >= 0; i--) {
    const s = snapshots[i];
    if (s.ts < windowStart) break;
    if (lastSelectedTs - s.ts >= minIntervalMs) {
      selected.push(s);
      lastSelectedTs = s.ts;
    }
  }

  // Fall back to array tail if window yields fewer than 3 snapshots (cold start)
  if (selected.length < 3) {
    return snapshots.slice(-30);
  }

  return selected.reverse(); // chronological order
}

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
    // Snapshot throttle: skip collection if last snapshot is less than 5 minutes old
    const lastTs = getLastSnapshotTimestamp();
    if (lastTs && (Date.now() - lastTs) < MIN_SNAPSHOT_INTERVAL_MS) {
      return { success: true, snapshotTaken: false, adjustmentMade: false };
    }

    // Overdrive check: skip adjustment if overdrive is active
    try {
      const configPath = getConfigPath();
      if (fs.existsSync(configPath)) {
        const overdriveConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (overdriveConfig.overdrive?.active) {
          if (new Date() > new Date(overdriveConfig.overdrive.expires_at)) {
            // Expired - revert and continue with normal adjustment
            revertOverdrive(overdriveConfig, log);
          } else {
            // Active - take snapshot but skip adjustment
            log(`Usage optimizer: Overdrive active until ${overdriveConfig.overdrive.expires_at}, skipping cooldown adjustment.`);
            const snapshot = await collectSnapshot(log);
            if (snapshot) {
              storeSnapshot(snapshot, log);
            }
            return { success: true, snapshotTaken: !!snapshot, adjustmentMade: false };
          }
        }
      }
    } catch (err) {
      log(`Usage optimizer: Overdrive check failed (non-fatal): ${err.message}`);
    }

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
  const rawKeyData = {};
  const keyLookup = new Map();

  for (const key of keys) {
    keyLookup.set(key.id, key);
    try {
      const usage = await fetchUsage(key.accessToken);
      if (usage) {
        rawKeyData[key.id] = {
          '5h': (usage.fiveHour.utilization ?? 0) / 100,
          '5h_reset': usage.fiveHour.resetsAt,
          '7d': (usage.sevenDay.utilization ?? 0) / 100,
          '7d_reset': usage.sevenDay.resetsAt,
        };
      }
    } catch (err) {
      log(`Usage optimizer: Failed to fetch usage for key ${key.id}: ${err.message}`);
    }
  }

  if (Object.keys(rawKeyData).length === 0) {
    log('Usage optimizer: No usage data retrieved, skipping snapshot.');
    return null;
  }

  // Deduplicate: group by account, keep first key per account.
  // Uses account_uuid as primary dedup key, falls back to a fingerprint
  // of usage values (same principle as cto-notification-hook.js).
  const accountMap = new Map();
  for (const [keyId, usage] of Object.entries(rawKeyData)) {
    const key = keyLookup.get(keyId);
    const dedupeKey = key?.accountId
      || `fp:${usage['5h']}:${usage['7d']}`;
    if (!accountMap.has(dedupeKey)) {
      accountMap.set(dedupeKey, { id: keyId, usage });
    }
  }

  // Build snapshot from deduplicated accounts
  const keyData = {};
  for (const [, entry] of accountMap) {
    keyData[entry.id] = entry.usage;
  }

  return { ts, keys: keyData };
}

/**
 * Get API keys from rotation state or credentials file.
 * Returns array of { id, accessToken }.
 */
function getApiKeys() {
  const keys = [];
  const now = Date.now();

  // Source 1: Environment variable override (highest priority)
  const envToken = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
  if (envToken) {
    return [{ id: 'env', accessToken: envToken, accountId: null }];
  }

  // Source 2: Rotation state (multiple keys) - check user-level, fallback to project-level
  const rotationPath = fs.existsSync(ROTATION_STATE_PATH) ? ROTATION_STATE_PATH
    : fs.existsSync(OLD_PROJECT_ROTATION_PATH) ? OLD_PROJECT_ROTATION_PATH
    : null;
  if (rotationPath) {
    try {
      const state = JSON.parse(fs.readFileSync(rotationPath, 'utf8'));
      if (state && state.keys && typeof state.keys === 'object') {
        for (const [id, data] of Object.entries(state.keys)) {
          if (!data.accessToken) continue;
          // Skip expired keys
          if (data.status === 'expired') continue;
          if (data.expiresAt && data.expiresAt < now) continue;
          keys.push({ id: id.substring(0, 8), accessToken: data.accessToken, accountId: data.account_uuid || null });
        }
      }
    } catch (err) {
      console.error(`[usage-optimizer] Failed to read rotation state: ${err.message}`);
    }
  }

  // Source 3: macOS Keychain (matches data-reader.ts:getCredentialToken)
  if (keys.length === 0 && process.platform === 'darwin') {
    try {
      const { username } = os.userInfo();
      const raw = execFileSync('security', [
        'find-generic-password', '-s', 'Claude Code-credentials', '-a', username, '-w',
      ], { encoding: 'utf8', timeout: 3000 }).trim();
      const creds = JSON.parse(raw);
      if (creds?.claudeAiOauth?.accessToken) {
        const expiresAt = creds.claudeAiOauth.expiresAt;
        if (!expiresAt || expiresAt > now) {
          keys.push({ id: 'keychain', accessToken: creds.claudeAiOauth.accessToken, accountId: null });
        }
      }
    } catch {
      // Keychain not available (locked, no entry, or non-macOS)
    }
  }

  // Source 4: Credentials file (~/.claude/.credentials.json)
  if (keys.length === 0 && fs.existsSync(CREDENTIALS_PATH)) {
    try {
      const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
      if (creds?.claudeAiOauth?.accessToken) {
        keys.push({ id: 'default', accessToken: creds.claudeAiOauth.accessToken, accountId: null });
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

  // Migrate old-format snapshots (0-100 scale → 0-1 fraction)
  for (const s of data.snapshots) {
    if (!s.keys) continue;
    for (const k of Object.values(s.keys)) {
      if ((k['5h'] ?? 0) > 1.0) k['5h'] = k['5h'] / 100;
      if ((k['7d'] ?? 0) > 1.0) k['7d'] = k['7d'] / 100;
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

  // Reset-boundary detection: if 5h utilization dropped >30pp between consecutive
  // recent snapshots, a window reset just happened. Skip this cycle to avoid
  // the stale rate causing the factor to ramp up blindly.
  // Compare only COMMON keys to avoid false positives when keys are added/removed.
  if (data.snapshots.length >= 2) {
    const prev = data.snapshots[data.snapshots.length - 2];
    const curr = data.snapshots[data.snapshots.length - 1];
    const commonKeys = Object.keys(curr.keys).filter(k => k in prev.keys);
    if (commonKeys.length > 0) {
      let prevSum5h = 0, currSum5h = 0;
      for (const k of commonKeys) {
        prevSum5h += prev.keys[k]['5h'] ?? 0;
        currSum5h += curr.keys[k]['5h'] ?? 0;
      }
      const drop5h = (prevSum5h / commonKeys.length) - (currSum5h / commonKeys.length);
      if (drop5h >= RESET_BOUNDARY_DROP_THRESHOLD) {
        log(`Usage optimizer: Reset boundary detected (5h dropped ${Math.round(drop5h * 100)}pp). Skipping adjustment cycle.`);
        return false;
      }
    }
  }

  // Get the most relevant metrics (aggregate across keys)
  const latest = data.snapshots[data.snapshots.length - 1];
  const timeBasedWindow = selectTimeBasedSnapshots(data.snapshots, EMA_WINDOW_MS, EMA_MIN_INTERVAL_MS);
  const earliest = timeBasedWindow[0]; // First snapshot in time-based window

  const hoursBetween = (latest.ts - earliest.ts) / (1000 * 60 * 60);
  if (hoursBetween < 0.15) { // Less than ~10 minutes of data
    log('Usage optimizer: Not enough time span for trajectory. Skipping.');
    return false;
  }

  // Calculate aggregate metrics across all keys (with EMA from all snapshots)
  const aggregate = calculateAggregate(latest, earliest, hoursBetween, data.snapshots);
  if (!aggregate) {
    log('Usage optimizer: Could not calculate aggregate metrics.');
    return false;
  }

  // Determine constraining metric
  // Cap projections to prevent runaway extrapolation — linear rate projection
  // over long horizons (e.g. 155h for 7d) produces nonsensical values that
  // pin the factor at MIN_FACTOR permanently.
  const MAX_PROJECTION = 1.5;
  const projected5h = Math.min(MAX_PROJECTION, aggregate.current5h + (aggregate.rate5h * aggregate.hoursUntil5hReset));
  const projected7d = Math.min(MAX_PROJECTION, aggregate.current7d + (aggregate.rate7d * aggregate.hoursUntil7dReset));
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

  // Recovery: if factor is stuck at minimum but current usage is well below
  // target, the projection model was unreliable. Reset factor to baseline so
  // automations aren't permanently throttled.
  // 0.15 threshold = 85%+ slower than default; catches factors that drifted very low
  if (currentFactor <= 0.15 && currentUsage < TARGET_UTILIZATION * 0.5) {
    applyFactor(config, 1.0, constraining, projectedAtReset, log, hoursUntilReset);
    log(`Usage optimizer: Factor recovery — usage at ${Math.round(currentUsage * 100)}% (well below ${Math.round(TARGET_UTILIZATION * 100)}% target) but factor stuck at minimum. Reset to 1.0.`);
    return true;
  }

  // Per-key warnings: flag any key exceeding the warning threshold
  if (aggregate.perKeyUtilization) {
    for (const [keyId, util] of Object.entries(aggregate.perKeyUtilization)) {
      if (util['5h'] >= SINGLE_KEY_WARNING_THRESHOLD) {
        log(`Usage optimizer WARNING: Account ${keyId} at ${Math.round(util['5h'] * 100)}% 5h utilization`);
      }
      if (util['7d'] >= SINGLE_KEY_WARNING_THRESHOLD) {
        log(`Usage optimizer WARNING: Account ${keyId} at ${Math.round(util['7d'] * 100)}% 7d utilization`);
      }
    }
  }

  // Bias currentUsage upward if any single key is near exhaustion
  let effectiveUsage = currentUsage;
  const maxKeyUsage = constraining === '5h' ? aggregate.maxKey5h : aggregate.maxKey7d;
  if (maxKeyUsage >= SINGLE_KEY_WARNING_THRESHOLD) {
    effectiveUsage = Math.max(effectiveUsage, maxKeyUsage * 0.8);
  }

  // Edge case: already at or above target
  if (effectiveUsage >= TARGET_UTILIZATION) {
    // Never speed up if already near cap - clamp factor to <= 1.0
    const newFactor = Math.min(currentFactor, 1.0);
    if (newFactor !== currentFactor) {
      applyFactor(config, newFactor, constraining, projectedAtReset, log, hoursUntilReset);
      return true;
    }
    log(`Usage optimizer: Already at ${Math.round(effectiveUsage * 100)}% usage. Holding steady. Reset in ${hoursUntilReset.toFixed(1)}h.`);
    return false;
  }

  // Edge case: rate is zero or negative (usage flat/decreasing)
  if (currentRate <= 0) {
    // Conservatively speed up (5% per cycle, capped at MAX_FACTOR)
    const newFactor = Math.min(currentFactor * 1.05, MAX_FACTOR);
    if (Math.abs(newFactor - currentFactor) > 0.001) {
      applyFactor(config, newFactor, constraining, projectedAtReset, log, hoursUntilReset);
      return true;
    }
    return false;
  }

  // Normal case: calculate desired rate to hit target at reset
  const desiredRate = (TARGET_UTILIZATION - effectiveUsage) / hoursUntilReset;
  const rawRatio = desiredRate / currentRate;

  // Conservative bounds: max ±10% per cycle
  const clamped = Math.max(1.0 - MAX_CHANGE_PER_CYCLE, Math.min(1.0 + MAX_CHANGE_PER_CYCLE, rawRatio));
  let newFactor = currentFactor * clamped;

  // Overall bounds
  newFactor = Math.max(MIN_FACTOR, Math.min(MAX_FACTOR, newFactor));

  // Only apply if meaningful change
  if (Math.abs(newFactor - currentFactor) < 0.01) {
    log(`Usage optimizer: Factor unchanged (${currentFactor.toFixed(2)}). On track for ${Math.round(projectedAtReset * 100)}% at reset. Reset in ${hoursUntilReset.toFixed(1)}h.`);
    return false;
  }

  applyFactor(config, newFactor, constraining, projectedAtReset, log, hoursUntilReset);
  return true;
}

/**
 * Calculate EMA-smoothed rate from an array of snapshots.
 * Uses exponential moving average of per-interval deltas for smoother estimation.
 *
 * @param {Array} snapshots - Array of raw snapshots (must have .ts and .keys)
 * @param {'5h'|'7d'} metricKey - Which metric to compute rate for
 * @param {number} [alpha=0.3] - EMA smoothing factor (higher = more weight on recent)
 * @returns {number} Smoothed rate per hour
 */
function calculateEmaRate(snapshots, metricKey, alpha = 0.3) {
  if (snapshots.length < 2) return 0;

  let emaRate = null;

  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1];
    const curr = snapshots[i];
    const hoursDelta = (curr.ts - prev.ts) / (1000 * 60 * 60);
    if (hoursDelta < MIN_HOURS_DELTA) continue; // Skip rapid-fire intervals (<3 min)

    // Average across common keys for this pair
    const commonKeys = Object.keys(curr.keys).filter(k => k in prev.keys);
    if (commonKeys.length === 0) continue;

    let sumCurr = 0, sumPrev = 0;
    for (const k of commonKeys) {
      sumCurr += curr.keys[k][metricKey] ?? 0;
      sumPrev += prev.keys[k][metricKey] ?? 0;
    }
    const avgCurr = sumCurr / commonKeys.length;
    const avgPrev = sumPrev / commonKeys.length;
    const intervalRate = (avgCurr - avgPrev) / hoursDelta;

    if (emaRate === null) {
      emaRate = intervalRate;
    } else {
      emaRate = alpha * intervalRate + (1 - alpha) * emaRate;
    }
  }

  return emaRate ?? 0;
}

/**
 * Calculate aggregate metrics across all keys in a snapshot pair.
 * Uses EMA-smoothed rates from recent snapshots for stability.
 * Also tracks per-key utilization and max values across keys.
 */
function calculateAggregate(latest, earliest, hoursBetween, allSnapshots) {
  const latestEntries = Object.entries(latest.keys);
  if (latestEntries.length === 0) return null;

  // Use all latest keys for current state + per-key tracking
  let sum5h = 0, sum7d = 0;
  let maxKey5h = 0, maxKey7d = 0;
  let resetAt5h = null, resetAt7d = null;
  const perKeyUtilization = {};

  for (const [id, k] of latestEntries) {
    const val5h = k['5h'] ?? 0;
    const val7d = k['7d'] ?? 0;
    sum5h += val5h;
    sum7d += val7d;
    maxKey5h = Math.max(maxKey5h, val5h);
    maxKey7d = Math.max(maxKey7d, val7d);
    perKeyUtilization[id] = { '5h': val5h, '7d': val7d };
    if (k['5h_reset']) resetAt5h = k['5h_reset'];
    if (k['7d_reset']) resetAt7d = k['7d_reset'];
  }

  const numKeys = latestEntries.length;
  const current5h = sum5h / numKeys;
  const current7d = sum7d / numKeys;

  // Calculate rates: use EMA from recent snapshots if available, fall back to two-point slope
  let rate5h = 0, rate7d = 0;
  if (allSnapshots && allSnapshots.length >= 3) {
    const recentSnapshots = selectTimeBasedSnapshots(allSnapshots, EMA_WINDOW_MS, EMA_MIN_INTERVAL_MS);
    rate5h = calculateEmaRate(recentSnapshots, '5h');
    rate7d = calculateEmaRate(recentSnapshots, '7d');
  } else {
    // Fallback: two-point slope from common keys
    const commonKeyIds = latestEntries
      .map(([id]) => id)
      .filter(id => id in earliest.keys);

    if (commonKeyIds.length > 0 && hoursBetween > 0) {
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

  return {
    current5h, current7d, rate5h, rate7d,
    hoursUntil5hReset, hoursUntil7dReset,
    maxKey5h, maxKey7d, perKeyUtilization,
  };
}

/**
 * Apply a new factor to the config, recalculating all effective cooldowns.
 */
function applyFactor(config, newFactor, constraining, projectedAtReset, log, hoursUntilReset) {
  const previousFactor = config.adjustment?.factor ?? 1.0;
  const defaults = getDefaults();

  // Calculate effective cooldowns: higher factor = shorter cooldowns = more activity
  const effective = {};
  for (const [key, defaultVal] of Object.entries(defaults)) {
    // Skip static-mode automations - they keep their fixed interval
    if (config.modes?.[key]?.mode === 'static') {
      effective[key] = config.modes[key].static_minutes ?? defaultVal;
      continue;
    }
    let computed = Math.max(MIN_EFFECTIVE_MINUTES, Math.round(defaultVal / newFactor));
    if (MAX_COOLDOWN_MINUTES[key] !== undefined) {
      computed = Math.min(computed, MAX_COOLDOWN_MINUTES[key]);
    }
    effective[key] = computed;
  }

  const direction = newFactor > previousFactor + 0.005 ? 'ramping up' : newFactor < previousFactor - 0.005 ? 'ramping down' : 'holding';

  config.effective = effective;
  config.adjustment = {
    factor: Math.round(newFactor * 1000) / 1000, // 3 decimal places
    last_updated: new Date().toISOString(),
    constraining_metric: constraining,
    projected_at_reset: Math.round(projectedAtReset * 1000) / 1000,
    direction,
    hours_until_reset: hoursUntilReset != null ? Math.round(hoursUntilReset * 10) / 10 : null,
  };

  const configPath = getConfigPath();
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    const resetStr = hoursUntilReset != null ? ` Reset in ${hoursUntilReset.toFixed(1)}h.` : '';
    log(`Usage optimizer: Factor ${newFactor.toFixed(3)} (was ${previousFactor.toFixed(3)}), ${direction}. ` +
        `Constraining: ${constraining}. Projected at reset: ${Math.round(projectedAtReset * 100)}%.${resetStr}`);
  } catch (err) {
    log(`Usage optimizer: Failed to write config: ${err.message}`);
  }
}
