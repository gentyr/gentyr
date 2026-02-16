#!/usr/bin/env node
/**
 * API Key Rotation Hook
 *
 * Runs on SessionStart to track multiple Claude API keys and automatically
 * rotate between them based on utilization thresholds.
 *
 * Features:
 * - Captures new keys from all sources (env var, macOS Keychain, credentials file)
 * - Monitors usage via Anthropic Usage API
 * - Rotates to lower-utilization keys when current key hits 90%+ usage
 * - Attempts OAuth token refresh for expired keys
 * - Logs all rotation events for debugging
 *
 * Storage:
 * - ~/.claude/api-key-rotation.json - Tracked keys and state (user-level, cross-project)
 * - <project>/.claude/api-key-rotation.log - Human-readable event log (project-level)
 *
 * @version 2.0.0
 */

import { fileURLToPath } from 'url';
import { registerHookExecution, HOOK_TYPES } from './agent-tracker.js';
import {
  syncKeys,
  readRotationState,
  writeRotationState,
  logRotationEvent,
  updateActiveCredentials,
  refreshExpiredToken,
} from './key-sync.js';

const __filename = fileURLToPath(import.meta.url);

// Configuration
const ANTHROPIC_API_URL = 'https://api.anthropic.com/api/oauth/usage';
const ANTHROPIC_BETA_HEADER = 'oauth-2025-04-20';

// Rotation thresholds (API returns utilization as 0-100 percentages)
const HIGH_USAGE_THRESHOLD = 90;  // 90%
const EXHAUSTED_THRESHOLD = 100;  // 100%

/**
 * @typedef {Object} UsageData
 * @property {number} five_hour
 * @property {number} seven_day
 * @property {number} seven_day_sonnet
 * @property {number} checked_at
 */

/**
 * @typedef {Object} KeyData
 * @property {string} accessToken
 * @property {string} refreshToken
 * @property {number} expiresAt
 * @property {string} subscriptionType
 * @property {string} rateLimitTier
 * @property {number} added_at
 * @property {number|null} last_used_at
 * @property {number|null} last_health_check
 * @property {UsageData|null} last_usage
 * @property {'active'|'exhausted'|'invalid'|'expired'} status
 */

/**
 * @typedef {Object} RotationLogEntry
 * @property {number} timestamp
 * @property {'key_added'|'key_removed'|'key_switched'|'key_exhausted'|'health_check'} event
 * @property {string} key_id
 * @property {string} [reason]
 * @property {{five_hour: number, seven_day: number, seven_day_sonnet: number}} [usage_snapshot]
 */

/**
 * @typedef {Object} KeyRotationState
 * @property {1} version
 * @property {string|null} active_key_id
 * @property {Record<string, KeyData>} keys
 * @property {RotationLogEntry[]} rotation_log
 */

/**
 * Check the health/usage of a key via Anthropic API
 * @param {string} accessToken
 * @returns {Promise<{valid: boolean, usage: {five_hour: number, seven_day: number, seven_day_sonnet: number} | null, error?: string}>}
 */
async function checkKeyHealth(accessToken) {
  try {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'claude-code/2.1.14',
        'anthropic-beta': ANTHROPIC_BETA_HEADER,
      },
    });

    if (response.status === 401) {
      return { valid: false, usage: null, error: 'unauthorized' };
    }

    if (!response.ok) {
      return { valid: false, usage: null, error: `http_${response.status}` };
    }

    const data = await response.json();

    return {
      valid: true,
      usage: {
        five_hour: data.five_hour?.utilization ?? 0,
        seven_day: data.seven_day?.utilization ?? 0,
        seven_day_sonnet: data.seven_day_sonnet?.utilization ?? 0,
      }
    };
  } catch (err) {
    return { valid: false, usage: null, error: err.message };
  }
}

/**
 * Select the best key to use based on current usage levels
 * @param {KeyRotationState} state
 * @returns {string|null}
 */
function selectActiveKey(state) {
  const validKeys = Object.entries(state.keys)
    .filter(([_, key]) => key.status === 'active' || key.status === 'exhausted')
    .map(([id, key]) => ({ id, key, usage: key.last_usage }));

  if (validKeys.length === 0) return null;

  // Filter out keys at 100% in ANY category (unusable)
  const usableKeys = validKeys.filter(({ usage }) => {
    if (!usage) return true; // No data yet, assume usable
    return usage.five_hour < EXHAUSTED_THRESHOLD &&
           usage.seven_day < EXHAUSTED_THRESHOLD &&
           usage.seven_day_sonnet < EXHAUSTED_THRESHOLD;
  });

  if (usableKeys.length === 0) return null; // All keys exhausted

  // Check if ALL usable keys are above 90% in at least one category
  const allAbove90 = usableKeys.every(({ usage }) => {
    if (!usage) return false;
    return usage.five_hour >= HIGH_USAGE_THRESHOLD ||
           usage.seven_day >= HIGH_USAGE_THRESHOLD ||
           usage.seven_day_sonnet >= HIGH_USAGE_THRESHOLD;
  });

  // Current key info
  const currentKey = state.active_key_id
    ? usableKeys.find(k => k.id === state.active_key_id)
    : null;

  if (allAbove90) {
    // All keys high usage: only switch when current is completely exhausted
    if (currentKey) {
      const currentUsage = currentKey.usage;
      if (currentUsage && (
        currentUsage.five_hour >= EXHAUSTED_THRESHOLD ||
        currentUsage.seven_day >= EXHAUSTED_THRESHOLD ||
        currentUsage.seven_day_sonnet >= EXHAUSTED_THRESHOLD
      )) {
        // Current key hit 100% somewhere, switch to another
        const otherKey = usableKeys.find(k => k.id !== state.active_key_id);
        return otherKey?.id ?? null;
      }
      return currentKey.id; // Stick with current
    }
  } else {
    // Some keys below 90%: switch when current reaches >=90% in any category
    if (currentKey?.usage) {
      const maxUsage = Math.max(
        currentKey.usage.five_hour,
        currentKey.usage.seven_day,
        currentKey.usage.seven_day_sonnet
      );

      if (maxUsage >= HIGH_USAGE_THRESHOLD) {
        // Find key with lowest max usage
        const sortedByUsage = usableKeys
          .filter(k => k.id !== state.active_key_id && k.usage)
          .sort((a, b) => {
            const aMax = Math.max(a.usage.five_hour, a.usage.seven_day, a.usage.seven_day_sonnet);
            const bMax = Math.max(b.usage.five_hour, b.usage.seven_day, b.usage.seven_day_sonnet);
            return aMax - bMax;
          });

        if (sortedByUsage.length > 0 && sortedByUsage[0].usage) {
          const altMax = Math.max(
            sortedByUsage[0].usage.five_hour,
            sortedByUsage[0].usage.seven_day,
            sortedByUsage[0].usage.seven_day_sonnet
          );
          if (altMax < HIGH_USAGE_THRESHOLD) {
            return sortedByUsage[0].id;
          }
        }
      }
    }
  }

  // Default: use current key or pick first usable
  return currentKey?.id ?? usableKeys[0]?.id ?? null;
}

/**
 * Main entry point
 */
async function main() {
  const startTime = Date.now();

  // Skip for spawned sessions
  if (process.env.CLAUDE_SPAWNED_SESSION === 'true') {
    registerHookExecution({
      hookType: HOOK_TYPES.API_KEY_WATCHER,
      status: 'skipped',
      durationMs: Date.now() - startTime,
      metadata: { reason: 'spawned_session' }
    });
    console.log(JSON.stringify({
      continue: true,
      suppressOutput: true,
    }));
    return;
  }

  // Step 1: Sync keys from all credential sources (env, keychain, file)
  const syncResult = await syncKeys();

  // Step 2: Read the synced rotation state for health checks + rotation
  const state = readRotationState();
  const now = Date.now();

  if (Object.keys(state.keys).length === 0) {
    // No keys tracked, nothing to do
    console.log(JSON.stringify({
      continue: true,
      suppressOutput: true,
    }));
    return;
  }

  // Step 3: Run health checks on all tracked keys (with token refresh for expired)
  const healthCheckPromises = Object.entries(state.keys).map(async ([keyId, keyData]) => {
    // Skip invalid keys
    if (keyData.status === 'invalid') {
      return { keyId, result: null };
    }

    // Check if token is expired - attempt refresh first
    if (keyData.expiresAt && keyData.expiresAt < now) {
      if (keyData.status !== 'expired') {
        const refreshed = await refreshExpiredToken(keyData);
        if (refreshed) {
          keyData.accessToken = refreshed.accessToken;
          keyData.refreshToken = refreshed.refreshToken;
          keyData.expiresAt = refreshed.expiresAt;
          keyData.status = 'active';
          logRotationEvent(state, {
            timestamp: now,
            event: 'key_added',
            key_id: keyId,
            reason: 'token_refreshed_during_health_check',
          });
        } else {
          keyData.status = 'expired';
          logRotationEvent(state, {
            timestamp: now,
            event: 'key_removed',
            key_id: keyId,
            reason: 'token_expired',
          });
          return { keyId, result: null };
        }
      } else {
        return { keyId, result: null };
      }
    }

    // Run health check
    const result = await checkKeyHealth(keyData.accessToken);
    return { keyId, result };
  });

  const healthResults = await Promise.all(healthCheckPromises);

  // Process health check results
  for (const { keyId, result } of healthResults) {
    if (!result) continue;

    const keyData = state.keys[keyId];
    keyData.last_health_check = now;

    if (!result.valid) {
      keyData.status = 'invalid';
      logRotationEvent(state, {
        timestamp: now,
        event: 'key_removed',
        key_id: keyId,
        reason: `health_check_failed_${result.error}`,
      });
    } else if (result.usage) {
      keyData.last_usage = {
        ...result.usage,
        checked_at: now,
      };

      // Check if exhausted
      const isExhausted = result.usage.five_hour >= EXHAUSTED_THRESHOLD ||
                          result.usage.seven_day >= EXHAUSTED_THRESHOLD ||
                          result.usage.seven_day_sonnet >= EXHAUSTED_THRESHOLD;

      if (isExhausted && keyData.status !== 'exhausted') {
        keyData.status = 'exhausted';
        logRotationEvent(state, {
          timestamp: now,
          event: 'key_exhausted',
          key_id: keyId,
          reason: 'hit_100_percent',
          usage_snapshot: result.usage,
        });
      } else if (!isExhausted && keyData.status === 'exhausted') {
        keyData.status = 'active';
      }

      logRotationEvent(state, {
        timestamp: now,
        event: 'health_check',
        key_id: keyId,
        usage_snapshot: result.usage,
      });
    }
  }

  // Step 4: Select the best key
  const selectedKeyId = selectActiveKey(state);

  // Check if we need to switch keys
  if (selectedKeyId && selectedKeyId !== state.active_key_id) {
    const previousKeyId = state.active_key_id;
    state.active_key_id = selectedKeyId;

    const selectedKey = state.keys[selectedKeyId];
    selectedKey.last_used_at = now;

    logRotationEvent(state, {
      timestamp: now,
      event: 'key_switched',
      key_id: selectedKeyId,
      reason: previousKeyId ? `switched_from_${previousKeyId.slice(0, 8)}` : 'initial_selection',
      usage_snapshot: selectedKey.last_usage ? {
        five_hour: selectedKey.last_usage.five_hour,
        seven_day: selectedKey.last_usage.seven_day,
        seven_day_sonnet: selectedKey.last_usage.seven_day_sonnet,
      } : undefined,
    });

    // Update credentials in all stores if switching to a different key
    if (previousKeyId) {
      updateActiveCredentials(selectedKey);
    }
  } else if (!state.active_key_id && selectedKeyId) {
    // First time setting active key
    state.active_key_id = selectedKeyId;
    state.keys[selectedKeyId].last_used_at = now;
  }

  // Save state
  writeRotationState(state);

  // Build notification message if there are multiple keys or rotation happened
  const keyCount = Object.keys(state.keys).filter(id =>
    state.keys[id].status === 'active' || state.keys[id].status === 'exhausted'
  ).length;

  let message = null;

  if (keyCount > 1) {
    const activeKey = state.keys[state.active_key_id];
    const usage = activeKey?.last_usage;

    if (usage) {
      const maxUsage = Math.max(usage.five_hour, usage.seven_day, usage.seven_day_sonnet);
      message = `Keys: ${keyCount} tracked | Active: ${state.active_key_id.slice(0, 8)}... (${Math.round(maxUsage)}% max usage)`;
    } else {
      message = `Keys: ${keyCount} tracked | Active: ${state.active_key_id.slice(0, 8)}...`;
    }
  }

  registerHookExecution({
    hookType: HOOK_TYPES.API_KEY_WATCHER,
    status: 'success',
    durationMs: Date.now() - startTime,
    metadata: {
      keyCount,
      switched: selectedKeyId !== state.active_key_id,
      keysAdded: syncResult.keysAdded,
      tokensRefreshed: syncResult.tokensRefreshed,
    }
  });

  console.log(JSON.stringify({
    continue: true,
    suppressOutput: !message,
    ...(message && { systemMessage: message }),
  }));
}

main().catch(err => {
  console.error(`[api-key-watcher] Error: ${err.message}`);

  registerHookExecution({
    hookType: HOOK_TYPES.API_KEY_WATCHER,
    status: 'failure',
    durationMs: 0,
    metadata: { error: err.message }
  });

  // Don't block on errors
  console.log(JSON.stringify({
    continue: true,
    suppressOutput: true,
  }));
});
